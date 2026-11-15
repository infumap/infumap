#!/usr/bin/env bash
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

usage() {
  cat <<'EOF'
Usage: tools/deploy-infumap.sh --host ssh-host --archive release.tar.gz [options]

Deploy a Linux archive produced by build-release.sh over SSH. The matching
release.tar.gz.sha256 file must be beside the archive. Use ~/.ssh/config for
the SSH user, identity file, port and any jump host.

Options:
  --host HOST        SSH config alias or [user@]hostname.
  --archive PATH     ARM64 or x86-64 Linux musl release archive.
  --install-only     Install without starting a service (first installation).
                     Refuses to replace the binary if the service is running.
  --timeout SECONDS  HTTP readiness timeout after starting the service (default 300).
  --health-url URL   Remote HTTP readiness URL (default http://127.0.0.1:8000/).
  -h, --help         Show this help.

Installs /opt/infumap/bin/infumap and /opt/infumap/LICENSE.txt as root.
Updates require infumap-web.service, /mnt/enc mounted and settings at
/mnt/enc/infudata/settings.toml. Sudo may prompt for the remote admin password.
The old executable is discarded; failures require manual recovery.
EOF
}

fail() { echo "Error: $*" >&2; exit 1; }

HOST=""
ARCHIVE=""
INSTALL_ONLY=0
TIMEOUT=300
HEALTH_URL=http://127.0.0.1:8000/
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host|--archive|--timeout|--health-url)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value."
      case "$1" in
        --host) HOST="$2" ;;
        --archive) ARCHIVE="$2" ;;
        --timeout) TIMEOUT="$2" ;;
        --health-url) HEALTH_URL="$2" ;;
      esac
      shift 2
      ;;
    --install-only) INSTALL_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$HOST" && -n "$ARCHIVE" ]] || { usage >&2; exit 1; }
[[ "$HOST" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]] || fail "Use an SSH alias or [user@]hostname for --host."
[[ "$TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] && (( TIMEOUT <= 86400 )) || fail "--timeout must be between 1 and 86400 seconds."
[[ "$HEALTH_URL" == http://* || "$HEALTH_URL" == https://* ]] || fail "--health-url must be an HTTP or HTTPS URL."
for command in ssh scp python3; do
  command -v "$command" >/dev/null || fail "Required local command: $command"
done
[[ -f "$ARCHIVE" && -f "$ARCHIVE.sha256" ]] || fail "The archive and its .sha256 file must both exist."
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
[[ "$ARCHIVE_NAME" =~ ^infumap-[a-zA-Z0-9.+_-]+-(aarch64|x86_64)-unknown-linux-musl\.tar\.gz$ ]] || fail "Expected a Linux musl release archive from build-release.sh."
PACKAGE_DIR="${ARCHIVE_NAME%.tar.gz}"
case "$ARCHIVE_NAME" in
  *-aarch64-unknown-linux-musl.tar.gz) REMOTE_ARCH=aarch64 ;;
  *-x86_64-unknown-linux-musl.tar.gz) REMOTE_ARCH=x86_64 ;;
esac

# Validate the exact package layout before any remote changes. In particular,
# links or unexpected paths must never reach the privileged extraction step.
EXPECTED_DIGEST="$(python3 - "$ARCHIVE" <<'PY'
import hashlib
import pathlib
import re
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
try:
    checksum = re.fullmatch(r"([0-9a-f]{64})  " + re.escape(archive.name) + r"\n?",
                            pathlib.Path(str(archive) + ".sha256").read_text())
    if checksum is None:
        raise ValueError("invalid checksum file or archive filename mismatch")
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != checksum[1]:
        raise ValueError("archive checksum mismatch")
    package = archive.name[:-len(".tar.gz")]
    with tarfile.open(archive, "r:gz") as release:
        members = release.getmembers()
        expected = {package, package + "/infumap", package + "/LICENSE.txt"}
        if len(members) != 3 or {entry.name for entry in members} != expected:
            raise ValueError("unexpected archive contents")
        for entry in members:
            if not (entry.isdir() if entry.name == package else entry.isfile()):
                raise ValueError("archive must contain only a directory, executable and license")
    print(digest.hexdigest())
except (OSError, ValueError, tarfile.TarError) as error:
    sys.exit(f"Error: {error}")
PY
)"

LOCAL_STAGING="$(mktemp -d)"
REMOTE_STAGING=""
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf "$LOCAL_STAGING"
  if [[ -n "$REMOTE_STAGING" ]]; then
    ssh -n -- "$HOST" "rm -rf -- '$REMOTE_STAGING'" || echo "Could not remove remote staging directory $REMOTE_STAGING" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

echo "Checking $HOST and preparing upload..."
REMOTE_STAGING="$(ssh -- "$HOST" "bash -s -- '$REMOTE_ARCH' '$INSTALL_ONLY'" <<'REMOTE'
set -euo pipefail
[[ "$(uname -s)" == Linux && "$(uname -m)" == "$1" ]] || { echo 'Error: remote OS/CPU does not match the archive.' >&2; exit 1; }
for command in sudo tar sha256sum install mktemp flock systemctl mountpoint; do
  command -v "$command" >/dev/null || { echo "Error: required remote command: $command" >&2; exit 1; }
done
if [[ "$2" == 0 ]]; then
  command -v curl >/dev/null || { echo 'Error: install curl on the remote host.' >&2; exit 1; }
fi
mktemp -d /tmp/infumap-deploy.XXXXXXXXXX
REMOTE
)"
# This path is interpolated into remote shell commands and an scp destination.
if [[ ! "$REMOTE_STAGING" =~ ^/tmp/infumap-deploy\.[a-zA-Z0-9]{10}$ ]]; then
  REMOTE_STAGING=""
  fail "Unexpected remote staging path. Check SSH startup output."
fi

{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'INSTALL_ONLY=%q\nTIMEOUT=%q\nHEALTH_URL=%q\nEXPECTED_DIGEST=%q\nPACKAGE_DIR=%q\n' \
    "$INSTALL_ONLY" "$TIMEOUT" "$HEALTH_URL" "$EXPECTED_DIGEST" "$PACKAGE_DIR"
  cat <<'REMOTE'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
UPLOAD_DIR="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "Error: $*" >&2; exit 1; }
STAGING=""
SERVICE_TOUCHED=0
cleanup() {
  local status=$?
  trap - EXIT
  [[ -z "$STAGING" ]] || rm -rf "$STAGING"
  if [[ "$status" -ne 0 && "$SERVICE_TOUCHED" -eq 1 ]]; then
    echo 'Deployment failed; recovery is manual. Deployment does not keep a backup binary.' >&2
    systemctl --no-pager --full status infumap-web >&2 || true
    journalctl -u infumap-web -n 30 --no-pager >&2 || true
    tail -n 50 /var/log/infumap/infumap.log >&2 || true
  fi
  exit "$status"
}
trap cleanup EXIT

# Serialize deployments so two uploads cannot replace each other's executable.
exec 9>/run/lock/infumap-deploy.lock
flock -n 9 || fail 'Another deployment is already running.'
if [[ "$INSTALL_ONLY" -eq 1 ]]; then
  case "$(systemctl show -p ActiveState --value infumap-web)" in
    inactive|failed) ;;
    *) fail '--install-only requires infumap-web to be stopped.' ;;
  esac
else
  mountpoint -q /mnt/enc || fail '/mnt/enc must be unlocked and mounted before deployment.'
  [[ -f /mnt/enc/infudata/settings.toml ]] || fail 'Missing /mnt/enc/infudata/settings.toml.'
  [[ "$(systemctl show -p LoadState --value infumap-web)" == loaded ]] || fail 'Configure infumap-web.service first, or use --install-only.'
fi

install -d -o root -g root -m 0755 /opt/infumap /opt/infumap/bin
STAGING="$(mktemp -d /opt/infumap/bin/.deploy.XXXXXXXXXX)"
install -m 0600 "$UPLOAD_DIR/archive.tar.gz" "$STAGING/archive.tar.gz"
cd "$STAGING"
# Pin verification to the checksum validated locally, after copying into a
# root-owned directory, so the extracted bytes are the ones that were checked.
printf '%s  archive.tar.gz\n' "$EXPECTED_DIGEST" | sha256sum --check --status - || fail 'Remote archive checksum mismatch.'
tar --extract --gzip --file archive.tar.gz --no-same-owner --no-same-permissions
install -o root -g root -m 0755 "$PACKAGE_DIR/infumap" "$STAGING/infumap"
install -o root -g root -m 0644 "$PACKAGE_DIR/LICENSE.txt" "$STAGING/LICENSE.txt"

if [[ "$INSTALL_ONLY" -eq 0 ]]; then
  SERVICE_TOUCHED=1
  systemctl stop infumap-web
fi
# Staging on the same filesystem makes replacement atomic; the running
# executable is never overwritten in place. Recovery is deliberately manual.
mv -fT "$STAGING/infumap" /opt/infumap/bin/infumap
mv -fT "$STAGING/LICENSE.txt" /opt/infumap/LICENSE.txt
echo "Installed $PACKAGE_DIR to /opt/infumap/bin/infumap and /opt/infumap/LICENSE.txt."
if [[ "$INSTALL_ONLY" -eq 1 ]]; then
  echo 'Install complete. Configure the settings and infumap-web.service before starting Infumap.'
  exit 0
fi

systemctl reset-failed infumap-web
systemctl start infumap-web
echo "Waiting up to $TIMEOUT seconds for $HEALTH_URL ..."
DEADLINE=$((SECONDS + TIMEOUT))
while (( SECONDS < DEADLINE )); do
  REMAINING=$((DEADLINE - SECONDS))
  REQUEST_TIMEOUT=5
  (( REMAINING >= REQUEST_TIMEOUT )) || REQUEST_TIMEOUT=$REMAINING
  if systemctl is-active --quiet infumap-web && \
      curl --noproxy '*' --fail --silent --output /dev/null --connect-timeout "$REQUEST_TIMEOUT" --max-time "$REQUEST_TIMEOUT" "$HEALTH_URL" && \
      systemctl is-active --quiet infumap-web; then
    echo 'Deployment complete; infumap-web is active and serving HTTP.'
    exit 0
  fi
  sleep 1
done
fail "Infumap did not become ready within $TIMEOUT seconds."
REMOTE
} > "$LOCAL_STAGING/deploy.sh"

echo "Uploading $ARCHIVE_NAME..."
scp -- "$ARCHIVE" "$HOST:$REMOTE_STAGING/archive.tar.gz"
scp -- "$LOCAL_STAGING/deploy.sh" "$HOST:$REMOTE_STAGING/deploy.sh"
# A real SSH terminal lets sudo prompt normally. Feeding the installer through
# stdin would conflict with password input when a PTY is allocated.
ssh -t -- "$HOST" "sudo -- /bin/bash '$REMOTE_STAGING/deploy.sh'"
