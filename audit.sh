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
  Python: pip install pip-audit      (or: pipx install pip-audit)
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

echo "=== Rust audit ==="
if ! "$ROOT_DIR/audit-rust.sh"; then
  overall_exit=1
fi
echo ""

echo "=== npm audit ==="
if ! "$ROOT_DIR/audit-npm.sh"; then
  overall_exit=1
fi
echo ""

echo "=== Python audit ==="
if ! "$ROOT_DIR/audit-python.sh"; then
  overall_exit=1
fi
echo ""

if [[ "$overall_exit" -eq 0 ]]; then
  touch "$TIMESTAMP_FILE"
  echo "All audits passed. Timestamp recorded in .last-audit."
else
  echo "One or more audits reported issues. Fix them, then re-run ./audit.sh." >&2
  echo ".last-audit timestamp NOT updated." >&2
  exit 1
fi
