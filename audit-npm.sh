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
Usage: ./audit-npm.sh

Audit npm dependencies in web/ for known vulnerabilities.
Requires npm (included with Node.js).
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

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not installed. Install Node.js (see .nvmrc for the expected version)."
fi

if [[ ! -f "$ROOT_DIR/web/package-lock.json" ]]; then
  fail "web/package-lock.json not found. Run 'npm install' in web/ first."
fi

echo "Running npm audit for web/"
cd "$ROOT_DIR/web"
npm audit
