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

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_usage() {
  cat <<'EOF'
Usage: ./audit.sh --server | --gpu

Run dependency security audits for one host role:
  --server  Rust + npm audits for the build host
  --gpu     Python audits for the GPU/ML host

On success, records a role-specific timestamp so build.sh can warn when
the server build host has not been audited recently.

Required tools (install if missing):
  Rust:   cargo install cargo-deny   (or cargo install cargo-audit)
  Python: sudo apt install pipx && pipx install pip-audit   (Debian/Raspberry Pi OS)
          brew install pipx && pipx install pip-audit       (macOS)
          uv tool install pip-audit                         (universal, no pip needed)
  npm:    included with Node.js
EOF
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  print_usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  print_usage >&2
  fail "Expected exactly one of: --server or --gpu"
fi

MODE="$1"
TIMESTAMP_FILE=""
MODE_LABEL=""

case "$MODE" in
  --server)
    TIMESTAMP_FILE="$ROOT_DIR/.last-audit-server"
    MODE_LABEL="server"
    ;;
  --gpu)
    TIMESTAMP_FILE="$ROOT_DIR/.last-audit-gpu"
    MODE_LABEL="gpu"
    ;;
  *)
    print_usage >&2
    fail "Unknown argument: $MODE"
    ;;
esac

overall_exit=0
skipped_any=0

run_audit() {
  local title="$1"
  local script_path="$2"
  local status=0

  echo "=== $title ==="
  if "$script_path"; then
    :
  else
    status=$?
    if [[ "$status" -eq 2 ]]; then
      skipped_any=1
    else
      overall_exit=1
    fi
  fi
  echo ""
}

case "$MODE" in
  --server)
    run_audit "Rust audit" "$ROOT_DIR/audit-rust.sh"
    run_audit "npm audit" "$ROOT_DIR/audit-npm.sh"
    ;;
  --gpu)
    run_audit "Python audit" "$ROOT_DIR/audit-python.sh"
    ;;
esac

if [[ "$overall_exit" -eq 0 ]]; then
  if [[ "$skipped_any" -eq 0 ]]; then
    touch "$TIMESTAMP_FILE"
    echo "All $MODE_LABEL audits passed. Timestamp recorded in $(basename "$TIMESTAMP_FILE")."
  else
    echo "All available $MODE_LABEL audits passed, but some audits were skipped." >&2
    echo "Install the missing tools and re-run ./audit.sh $MODE for a complete audit." >&2
    echo "$(basename "$TIMESTAMP_FILE") timestamp NOT updated." >&2
  fi
else
  echo "One or more $MODE_LABEL audits reported issues. Fix them, then re-run ./audit.sh $MODE." >&2
  echo "$(basename "$TIMESTAMP_FILE") timestamp NOT updated." >&2
  exit 1
fi
