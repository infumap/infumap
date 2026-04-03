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
readonly TIMESTAMP_FILE="$ROOT_DIR/.last-audit"

print_usage() {
  cat <<'EOF'
Usage: ./audit.sh

Run all dependency security audits:
  - Rust   (cargo-deny preferred, falls back to cargo-audit)
  - npm    (npm audit)
  - Python (pip-audit)

On success, records a timestamp in .last-audit so that build.sh can
warn when more than a week has passed without an audit.

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

if [[ $# -gt 0 ]]; then
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      print_usage >&2
      fail "Unknown argument: $1"
      ;;
  esac
fi

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

run_audit "Rust audit" "$ROOT_DIR/audit-rust.sh"
run_audit "npm audit" "$ROOT_DIR/audit-npm.sh"
run_audit "Python audit" "$ROOT_DIR/audit-python.sh"

if [[ "$overall_exit" -eq 0 ]]; then
  if [[ "$skipped_any" -eq 0 ]]; then
    touch "$TIMESTAMP_FILE"
    echo "All audits passed. Timestamp recorded in .last-audit."
  else
    echo "All available audits passed, but some audits were skipped." >&2
    echo "Install the missing tools and re-run ./audit.sh for a complete audit." >&2
    echo ".last-audit timestamp NOT updated." >&2
  fi
else
  echo "One or more audits reported issues. Fix them, then re-run ./audit.sh." >&2
  echo ".last-audit timestamp NOT updated." >&2
  exit 1
fi
