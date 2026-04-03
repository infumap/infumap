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

skip() {
  echo "Skipping npm audit: $1" >&2
  exit 2
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
  skip "npm is not installed. Install Node.js (see .nvmrc for the expected version)."
fi

if [[ ! -f "$ROOT_DIR/web/package-lock.json" ]]; then
  fail "web/package-lock.json not found. Run 'npm install' in web/ first."
fi

cd "$ROOT_DIR/web"

echo "Running npm audit for web/"
audit_exit=0
npm audit || audit_exit=$?

echo ""
echo "Running npm audit signatures for web/"
npm audit signatures

if [[ "$audit_exit" -ne 0 ]]; then
  cat <<'EOF'

How to fix npm vulnerabilities:
  Automatic fix (safe changes only — no major version bumps):
    cd web && npm audit fix
  If vulnerabilities remain after that, check what's needed:
    cd web && npm audit
  For a breaking fix (major version bump — review the diff carefully):
    cd web && npm audit fix --force
  Then commit the updated package-lock.json and re-run ./audit.sh --server.

  If a vulnerability is in a transitive dependency with no fix available yet,
  you can temporarily suppress it in package.json under an "overrides" key:
    "overrides": { "vulnerable-package": ">=fixed.version" }
  Remove the override once the parent package releases a proper fix.
EOF
  exit "$audit_exit"
fi
