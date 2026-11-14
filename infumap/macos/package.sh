#!/bin/bash
# Copyright (C) The Infumap Authors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Certificate passwords must not appear in shell traces on CI runners.
set +x
set -euo pipefail

print_usage() {
  cat <<'EOF'
Usage: infumap/macos/package.sh [--sign] [--notarize] executable version output.zip

Package an already-built infumap-macos executable as Infumap.app.
Normally invoked by ./build-release.sh. Requires macOS and Apple's build tools.
--notarize implies --sign. With neither flag, use an ad hoc signature for local use.

Signing:
  MACOS_SIGNING_IDENTITY       Developer ID Application certificate name
  MACOS_SIGNING_KEYCHAIN       Optional existing keychain containing the identity
  MACOS_CERTIFICATE_BASE64     Optional base64 PKCS#12 certificate/private key for CI
  MACOS_CERTIFICATE_PASSWORD   Password for the PKCS#12 file (may be empty)

Notarization (choose one authentication method):
  MACOS_NOTARY_KEYCHAIN_PROFILE  Existing notarytool credentials profile
  MACOS_NOTARY_KEY_PATH          App Store Connect team API key (.p8), or
  MACOS_NOTARY_KEY_BASE64        Base64-encoded .p8 key for CI
  MACOS_NOTARY_KEY_ID            API key ID (required with a .p8 key)
  MACOS_NOTARY_ISSUER_ID         API key issuer ID (required with a .p8 key)

  MACOS_NOTARY_LOG_DIR         Directory for submission and diagnostic JSON files
                              (defaults to the output ZIP's directory)
  MACOS_NOTARY_TIMEOUT         How long to wait for Apple (default: 30m)
EOF
}

SIGN=0
NOTARIZE=0
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sign) SIGN=1 ;;
    --notarize) SIGN=1; NOTARIZE=1 ;;
    -h|--help) print_usage; exit 0 ;;
    -*) echo "Error: unknown option: $1" >&2; exit 1 ;;
    *) POSITIONAL+=("$1") ;;
  esac
  shift
done
if [[ ${#POSITIONAL[@]} -ne 3 ]]; then
  print_usage >&2
  exit 1
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Error: macOS app packaging requires macOS." >&2
  exit 1
fi
EXECUTABLE="${POSITIONAL[0]}"
VERSION="${POSITIONAL[1]}"
OUTPUT="${POSITIONAL[2]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -x "$EXECUTABLE" || "$OUTPUT" != *.zip ]]; then
  echo "Error: supply an executable file and an output path ending in .zip." >&2
  exit 1
fi
if [[ $SIGN -eq 1 && "${MACOS_SIGNING_IDENTITY:-}" != "Developer ID Application: "* ]]; then
  echo "Error: MACOS_SIGNING_IDENTITY must name a Developer ID Application certificate." >&2
  exit 1
fi
if [[ $SIGN -eq 1 && -n "${MACOS_CERTIFICATE_BASE64:-}" && -n "${MACOS_SIGNING_KEYCHAIN:-}" ]]; then
  echo "Error: choose MACOS_CERTIFICATE_BASE64 or MACOS_SIGNING_KEYCHAIN, not both." >&2
  exit 1
fi
NOTARY_ARGS=()
if [[ $NOTARIZE -eq 1 ]]; then
  if [[ -n "${MACOS_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
    if [[ -n "${MACOS_NOTARY_KEY_PATH:-}${MACOS_NOTARY_KEY_BASE64:-}" ]]; then
      echo "Error: choose a notarytool profile or API key authentication, not both." >&2
      exit 1
    fi
    NOTARY_ARGS+=(--keychain-profile "$MACOS_NOTARY_KEYCHAIN_PROFILE")
  else
    if [[ -z "${MACOS_NOTARY_KEY_ID:-}" || -z "${MACOS_NOTARY_ISSUER_ID:-}" ||
          -z "${MACOS_NOTARY_KEY_PATH:-}${MACOS_NOTARY_KEY_BASE64:-}" ]]; then
      echo "Error: notarization requires a credentials profile or a team API key, key ID and issuer ID." >&2
      exit 1
    fi
    if [[ -n "${MACOS_NOTARY_KEY_PATH:-}" && -n "${MACOS_NOTARY_KEY_BASE64:-}" ]]; then
      echo "Error: choose MACOS_NOTARY_KEY_PATH or MACOS_NOTARY_KEY_BASE64, not both." >&2
      exit 1
    fi
  fi
  xcrun --find notarytool >/dev/null
  xcrun --find stapler >/dev/null
fi

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/infumap-macos.XXXXXX")"
TEMP_KEYCHAIN=""
cleanup() {
  if [[ -n "$TEMP_KEYCHAIN" ]]; then
    security delete-keychain "$TEMP_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SIGN_ARGS=()
if [[ $SIGN -eq 1 ]]; then
  SIGN_ARGS+=(--options runtime --timestamp --sign "$MACOS_SIGNING_IDENTITY")
  if [[ -n "${MACOS_CERTIFICATE_BASE64:-}" ]]; then
    python3 - "$WORK/signing.p12" <<'PY'
import base64
import os
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode("".join(os.environ["MACOS_CERTIFICATE_BASE64"].split()), validate=True))
PY
    KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
    TEMP_KEYCHAIN="$WORK/signing.keychain-db"
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN"
    security set-keychain-settings -lut 21600 "$TEMP_KEYCHAIN"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN"
    security import "$WORK/signing.p12" -k "$TEMP_KEYCHAIN" \
      -P "${MACOS_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple: -s \
      -k "$KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN" >/dev/null
    rm "$WORK/signing.p12"
    SIGN_ARGS+=(--keychain "$TEMP_KEYCHAIN")
  elif [[ -n "${MACOS_SIGNING_KEYCHAIN:-}" ]]; then
    SIGN_ARGS+=(--keychain "$MACOS_SIGNING_KEYCHAIN")
  fi
else
  SIGN_ARGS+=(--sign -)
fi

if [[ $NOTARIZE -eq 1 && -z "${MACOS_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  NOTARY_KEY="${MACOS_NOTARY_KEY_PATH:-$WORK/notary.p8}"
  if [[ -n "${MACOS_NOTARY_KEY_BASE64:-}" ]]; then
    python3 - "$NOTARY_KEY" <<'PY'
import base64
import os
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode("".join(os.environ["MACOS_NOTARY_KEY_BASE64"].split()), validate=True))
PY
  fi
  if [[ ! -f "$NOTARY_KEY" ]]; then
    echo "Error: notarization API key file does not exist." >&2
    exit 1
  fi
  NOTARY_ARGS+=(--key "$NOTARY_KEY" --key-id "$MACOS_NOTARY_KEY_ID" --issuer "$MACOS_NOTARY_ISSUER_ID")
fi

APP="$WORK/Infumap.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$WORK/Infumap.iconset"
cp "$EXECUTABLE" "$APP/Contents/MacOS/infumap-macos"
chmod 755 "$APP" "$APP/Contents" "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/MacOS/infumap-macos"
cp "$SCRIPT_DIR/../../LICENSE.txt" "$APP/Contents/Resources/LICENSE.txt"

# The existing icon contains a 128px image. Reuse it for Finder's icon rather
# than introduce a second design; larger sizes are interpolated from that image.
python3 - "$SCRIPT_DIR/../../web/src/assets/favicon.ico" "$WORK/icon.png" <<'PY'
import pathlib
import struct
import sys

icon = pathlib.Path(sys.argv[1]).read_bytes()
count = struct.unpack_from("<H", icon, 4)[0]
frames = [struct.unpack_from("<BBBBHHII", icon, 6 + 16 * i) for i in range(count)]
frame = max(frames, key=lambda f: (f[0] or 256) * (f[1] or 256))
png = icon[frame[7]:frame[7] + frame[6]]
if not png.startswith(b"\x89PNG\r\n\x1a\n"):
    raise SystemExit("The largest favicon frame must be PNG-encoded for app packaging.")
pathlib.Path(sys.argv[2]).write_bytes(png)
PY
for SIZE in 16 32 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$WORK/icon.png" --out "$WORK/Infumap.iconset/icon_${SIZE}x${SIZE}.png" >/dev/null
  RETINA_SIZE=$((SIZE * 2))
  sips -z "$RETINA_SIZE" "$RETINA_SIZE" "$WORK/icon.png" --out "$WORK/Infumap.iconset/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/Infumap.iconset" -o "$APP/Contents/Resources/Infumap.icns"
python3 - "$APP/Contents/Info.plist" "$VERSION" <<'PY'
import pathlib
import plistlib
import sys

version = sys.argv[2]
metadata = {
    "CFBundleDevelopmentRegion": "en",
    "CFBundleDisplayName": "Infumap",
    "CFBundleExecutable": "infumap-macos",
    "CFBundleIconFile": "Infumap.icns",
    "CFBundleIdentifier": "com.infumap.Infumap",
    "CFBundleInfoDictionaryVersion": "6.0",
    "CFBundleName": "Infumap",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": version.split("-")[0].split("+")[0],
    "CFBundleVersion": version.split("-")[0].split("+")[0],
    "LSMinimumSystemVersion": "11.0",
    "LSUIElement": True,
    "NSHighResolutionCapable": True,
}
pathlib.Path(sys.argv[1]).write_bytes(plistlib.dumps(metadata))
PY
# Credentials are private, but all bundle resources must be readable after a
# different user installs the app. Finalize everything before sealing the bundle.
chmod -R a+rX "$APP"
codesign --force "${SIGN_ARGS[@]}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [[ $NOTARIZE -eq 1 ]]; then
  LOG_DIR="${MACOS_NOTARY_LOG_DIR:-$(dirname "$OUTPUT")}"
  mkdir -p "$LOG_DIR"
  LOG_BASE="$LOG_DIR/$(basename "$OUTPUT" .zip)-notary"
  rm -f "$LOG_BASE-log.json"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/submission.zip"
  SUBMIT_EXIT=0
  xcrun notarytool submit "$WORK/submission.zip" "${NOTARY_ARGS[@]}" \
    --wait --timeout "${MACOS_NOTARY_TIMEOUT:-30m}" --output-format json >"$LOG_BASE-submission.json" || SUBMIT_EXIT=$?
  # notarytool may return a submission ID even after a timeout or rejection.
  # Retain the ID and diagnostics; never package a submission as accepted based
  # solely on successful upload or the command's exit status.
  SUBMISSION_ID="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("id", ""))' "$LOG_BASE-submission.json")"
  STATUS="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("status", ""))' "$LOG_BASE-submission.json")"
  if [[ -n "$SUBMISSION_ID" && ( "$STATUS" == Accepted || "$STATUS" == Invalid || "$STATUS" == Rejected ) ]]; then
    xcrun notarytool log "$SUBMISSION_ID" "${NOTARY_ARGS[@]}" "$LOG_BASE-log.json"
    cat "$LOG_BASE-log.json"
  fi
  if [[ $SUBMIT_EXIT -ne 0 || "$STATUS" != Accepted || -z "$SUBMISSION_ID" ]]; then
    echo "Error: notarization was not accepted. Submission: $SUBMISSION_ID; status: $STATUS" >&2
    echo "See $LOG_BASE-submission.json and any downloaded log." >&2
    exit 1
  fi
  # Apple's ticket may take a short time to propagate after acceptance.
  STAPLE_ATTEMPT=0
  until xcrun stapler staple "$APP"; do
    STAPLE_ATTEMPT=$((STAPLE_ATTEMPT + 1))
    if [[ $STAPLE_ATTEMPT -ge 5 ]]; then
      echo "Error: could not staple the accepted notarization ticket." >&2
      exit 1
    fi
    sleep "$((2 ** STAPLE_ATTEMPT))"
  done
  xcrun stapler validate "$APP"
  if command -v syspolicy_check >/dev/null 2>&1; then
    syspolicy_check distribution "$APP"
  else
    spctl --assess --type execute --verbose=2 "$APP"
  fi
fi

# Stapling changes the app. Recreate the archive afterwards so the download
# contains the ticket; the submission ZIP must never be the published artifact.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUTPUT"
echo "Packaged $OUTPUT"
