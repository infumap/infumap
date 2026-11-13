#!/bin/bash
set -euo pipefail

# Copyright (C) The Infumap Authors
# This file is part of Infumap.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

print_usage() {
  cat <<'EOF'
Usage: ./build-release.sh [--skip-web] target-triple

Build and package one release executable, its license and a SHA-256 checksum.
Outputs go in the repository root's dist/ directory.

Targets:
  x86_64-unknown-linux-musl   infumap for Intel/AMD Linux
  aarch64-unknown-linux-musl  infumap for ARM64 Linux, including 64-bit Raspberry Pi
  aarch64-apple-darwin        infumap-macos for Apple Silicon macOS (build on macOS)

Options:
  --skip-web  Reuse web assets and generated Rust routes from ./web/build.sh.
  -h, --help Show this help.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKIP_WEB=0
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-web) SKIP_WEB=1 ;;
    -h|--help) print_usage; exit 0 ;;
    -*) echo "Error: unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "Error: specify exactly one target." >&2
        exit 1
      fi
      TARGET="$1"
      ;;
  esac
  shift
done

BUILD_ARGS=()
case "$TARGET" in
  x86_64-unknown-linux-musl|aarch64-unknown-linux-musl)
    BINARY=infumap
    BUILD_ARGS+=("$TARGET" --bin "$BINARY")
    ;;
  aarch64-apple-darwin)
    if [[ "$(uname -s)" != Darwin ]]; then
      echo "Error: the macOS release requires macOS and Apple's Command Line Tools." >&2
      exit 1
    fi
    BINARY=infumap-macos
    BUILD_ARGS+=(--macos-menu-bar)
    # Apply the same minimum to Rust and native dependencies as the AppKit code.
    export MACOSX_DEPLOYMENT_TARGET=11.0
    ;;
  *) print_usage >&2; exit 1 ;;
esac

if [[ $SKIP_WEB -eq 0 ]]; then
  "$SCRIPT_DIR/web/build.sh"
elif [[ ! -f "$SCRIPT_DIR/infumap/dist/index.html" || ! -f "$SCRIPT_DIR/infumap/src/web/dist_handlers.rs" ]]; then
  echo "Error: --skip-web requires infumap/dist/ and infumap/src/web/dist_handlers.rs from a web build." >&2
  exit 1
fi

"$SCRIPT_DIR/infumap/build.sh" "${BUILD_ARGS[@]}"

# Cargo metadata respects CARGO_TARGET_DIR and Cargo configuration; guessing
# infumap/target would package a stale binary when the build uses another path.
cd "$SCRIPT_DIR/infumap"
METADATA="$(cargo metadata --locked --no-deps --format-version 1)"
VERSION="$(python3 -c 'import json, sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "infumap"))' <<< "$METADATA")"
TARGET_DIRECTORY="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])' <<< "$METADATA")"
ARTIFACT="$BINARY-$VERSION-$TARGET"

mkdir -p "$SCRIPT_DIR/dist"
STAGING="$(mktemp -d "$SCRIPT_DIR/dist/.package.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
mkdir "$STAGING/$ARTIFACT"
cp "$TARGET_DIRECTORY/$TARGET/release/$BINARY" "$STAGING/$ARTIFACT/$BINARY"
cp "$SCRIPT_DIR/LICENSE.txt" "$STAGING/$ARTIFACT/LICENSE.txt"
tar -czf "$STAGING/$ARTIFACT.tar.gz" -C "$STAGING" "$ARTIFACT"

cd "$STAGING"
python3 - "$ARTIFACT.tar.gz" <<'PY'
import hashlib
import pathlib
import sys

archive = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
with archive.open("rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
pathlib.Path(f"{archive}.sha256").write_text(f"{digest.hexdigest()}  {archive.name}\n")
PY
mv "$ARTIFACT.tar.gz" "$ARTIFACT.tar.gz.sha256" "$SCRIPT_DIR/dist/"
echo "Created dist/$ARTIFACT.tar.gz and dist/$ARTIFACT.tar.gz.sha256"
