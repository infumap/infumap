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

# Requirements files to audit. Each entry is "label:path".
readonly REQUIREMENTS_FILES=(
  "text_embedding:tools/gpu/text_embedding/requirements.txt"
  "text_embedding (fastembed CPU):tools/gpu/text_embedding/requirements-fastembed.txt"
  "image_tagging:tools/gpu/image_tagging/requirements.txt"
  "text_extraction:tools/gpu/text_extraction/requirements.txt"
)

print_usage() {
  cat <<'EOF'
Usage: ./audit-python.sh

Audit Python dependencies for all GPU tools for known vulnerabilities.
Requires pip-audit. Install with one of:
  uv tool install pip-audit          # preferred: uv is a standalone binary, no pip needed
                                     # install uv: curl -LsSf https://astral.sh/uv/install.sh | sh
  python -m pip install --user pip-audit
  sudo apt install python3-pip && python -m pip install --user pip-audit  # Debian/Ubuntu
  brew install pipx && pipx install pip-audit                             # macOS Homebrew
EOF
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

# Find a working Python interpreter.
find_python() {
  for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf '%s' "$cmd"
      return 0
    fi
  done
  return 1
}

# Find pip-audit: prefer standalone commands, fall back to python -m pip_audit.
find_pip_audit() {
  if command -v pip-audit >/dev/null 2>&1; then
    printf '%s' "pip-audit"
    return 0
  fi
  # uv tool installs go to a uv-managed bin dir that may not be in PATH in all shells
  if command -v uv >/dev/null 2>&1 && uv tool run pip-audit --version >/dev/null 2>&1; then
    printf '%s' "uv tool run pip-audit"
    return 0
  fi
  local py
  if py="$(find_python)"; then
    if "$py" -m pip_audit --version >/dev/null 2>&1; then
      printf '%s' "$py -m pip_audit"
      return 0
    fi
  fi
  return 1
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

PIP_AUDIT_CMD=""
if ! PIP_AUDIT_CMD="$(find_pip_audit)"; then
  echo "pip-audit is not installed." >&2
  echo "Install it with one of:" >&2
  echo "  uv tool install pip-audit          # preferred: uv needs no pip" >&2
  echo "    (install uv: curl -LsSf https://astral.sh/uv/install.sh | sh)" >&2
  echo "  python -m pip install --user pip-audit" >&2
  echo "  sudo apt install python3-pip && python -m pip install --user pip-audit  # Debian/Ubuntu" >&2
  echo "  brew install pipx && pipx install pip-audit                             # macOS Homebrew" >&2
  exit 1
fi

overall_exit=0

for entry in "${REQUIREMENTS_FILES[@]}"; do
  label="${entry%%:*}"
  req_path="$ROOT_DIR/${entry#*:}"

  if [[ ! -f "$req_path" ]]; then
    echo "WARNING: requirements file not found, skipping $label: $req_path" >&2
    continue
  fi

  echo "Running pip-audit for $label ($req_path)"
  if ! $PIP_AUDIT_CMD -r "$req_path"; then
    overall_exit=1
  fi
  echo ""
done

exit "$overall_exit"
