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

# Requirements files to audit. Each entry is "label:path[:--ignore-vuln ID ...]".
# Use the ignore-vuln suffix for CVEs that are unfixable due to upstream dependency
# conflicts. Document the reason in the requirements.txt file and remove the
# suppression once the upstream package releases a fix.
readonly REQUIREMENTS_FILES=(
  "text_embedding:tools/gpu/text_embedding/requirements.txt"
  "text_embedding (fastembed CPU):tools/gpu/text_embedding/requirements-fastembed.txt"
  "image_tagging:tools/gpu/image_tagging/requirements.txt"
  # CVE-2026-25990 (pillow >=10.3.0,<12.1.1, CVSS 8.9): out-of-bounds write loading
  #   PSD images. Low risk here — PDFs rarely embed PSD files.
  # CVE-2025-68616 (weasyprint <68.0, CVSS 7.5): SSRF bypass via HTTP redirects.
  #   Low risk in a single-user self-controlled deployment; would be high risk if
  #   this service were exposed to untrusted document sources.
  # Both are unfixable while marker-pdf 1.10.2 pins Pillow<11.0.0 and weasyprint<64.0.
  # Remove suppressions once marker-pdf depends on pillow>=12.1.1 and weasyprint>=68.0.
  "text_extraction:tools/gpu/text_extraction/requirements.txt:--ignore-vuln CVE-2026-25990 --ignore-vuln CVE-2025-68616"
)

print_usage() {
  cat <<'EOF'
Usage: ./audit-python.sh

Audit Python dependencies for all GPU tools for known vulnerabilities.
Requires pip-audit. Install with one of:
  sudo apt install pipx && pipx install pip-audit   # Debian/Raspberry Pi OS
  brew install pipx && pipx install pip-audit       # macOS Homebrew
  uv tool install pip-audit                         # universal: uv needs no pip
    (install uv: curl -LsSf https://astral.sh/uv/install.sh | sh)
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
  echo "  sudo apt install pipx && pipx install pip-audit   # Debian/Raspberry Pi OS" >&2
  echo "  brew install pipx && pipx install pip-audit       # macOS Homebrew" >&2
  echo "  uv tool install pip-audit                         # universal: uv needs no pip" >&2
  echo "    (install uv: curl -LsSf https://astral.sh/uv/install.sh | sh)" >&2
  exit 1
fi

overall_exit=0

for entry in "${REQUIREMENTS_FILES[@]}"; do
  label="${entry%%:*}"
  rest="${entry#*:}"
  req_path="$ROOT_DIR/${rest%%:*}"
  extra_args="${rest#*:}"
  [[ "$extra_args" == "$rest" ]] && extra_args=""  # no extra args if no second colon

  if [[ ! -f "$req_path" ]]; then
    echo "WARNING: requirements file not found, skipping $label: $req_path" >&2
    continue
  fi

  echo "Running pip-audit for $label ($req_path)"
  if [[ -n "$extra_args" ]]; then
    suppressed="$(echo "$extra_args" | grep -o 'CVE-[0-9-]*' | tr '\n' ' ' | sed 's/ $//' || true)"
    echo "  NOTE: suppressed vulnerabilities (unfixable upstream conflicts): $suppressed"
    echo "        See tools/gpu/text_extraction/requirements.txt for details."
  fi
  # shellcheck disable=SC2086
  if ! $PIP_AUDIT_CMD -r "$req_path" $extra_args; then
    overall_exit=1
  fi
  echo ""
done

if [[ "$overall_exit" -ne 0 ]]; then
  cat <<'EOF'
How to fix Python vulnerabilities:
  1. If the vulnerable package is listed directly in requirements.txt:
       Update or pin the version there, e.g. change 'pillow' to 'pillow==12.1.1'
  2. If the vulnerable package is a transitive dependency (not in requirements.txt):
       Add it explicitly with the fixed version, e.g. add 'pillow==12.1.1' on its own line.
       This overrides the version that the parent package would otherwise pull in.
  3. Restart the affected service so it reinstalls from the updated requirements.txt.
  4. Re-run ./audit.sh to confirm the fix.

Skipped packages (shown in the table above with a "Skip Reason"):
  These could not be audited — usually because they have a non-standard version string
  not recognised by PyPI (e.g. flatbuffers 20181003210633 is a date-based version
  bundled inside onnxruntime). They are not confirmed safe — review them manually.
  If a newer version of the parent package (e.g. fastembed, onnxruntime) is available,
  upgrading it will usually resolve the non-standard version.
EOF
fi

exit "$overall_exit"
