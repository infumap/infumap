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
readonly CRATE_DIRS=(
  "infumap"
  "infusdk"
)

print_usage() {
  cat <<'EOF'
Usage: ./audit-rust.sh

Audit the Rust dependency graph for all checked-in crates.

The script prefers cargo-deny for advisories, source policy, and duplicate-version
checks. If cargo-deny is unavailable but cargo-audit is installed, it falls back
to advisory checks against the committed Cargo.lock files.
EOF
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

have_cargo_deny() {
  cargo deny --version >/dev/null 2>&1
}

have_cargo_audit() {
  cargo audit --version >/dev/null 2>&1
}

ensure_lockfile() {
  local crate_dir="$1"
  local lockfile_path="$ROOT_DIR/$crate_dir/Cargo.lock"

  if [[ ! -f "$lockfile_path" ]]; then
    fail "Missing lockfile for $crate_dir: $lockfile_path"
  fi
}

run_cargo_deny() {
  local crate_dir=""

  for crate_dir in "${CRATE_DIRS[@]}"; do
    local manifest_path="$ROOT_DIR/$crate_dir/Cargo.toml"
    ensure_lockfile "$crate_dir"

    echo "Running cargo-deny for $crate_dir"
    cargo deny --manifest-path "$manifest_path" check advisories bans sources
  done
}

run_cargo_audit() {
  local crate_dir=""

  echo "cargo-deny is not installed; falling back to cargo-audit advisories only." >&2

  for crate_dir in "${CRATE_DIRS[@]}"; do
    local lockfile_path="$ROOT_DIR/$crate_dir/Cargo.lock"
    ensure_lockfile "$crate_dir"

    echo "Running cargo-audit for $crate_dir"
    cargo audit --file "$lockfile_path"
  done
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

if have_cargo_deny; then
  run_cargo_deny
  exit 0
fi

if have_cargo_audit; then
  run_cargo_audit
  exit 0
fi

fail "Neither cargo-deny nor cargo-audit is installed. Install cargo-deny for full checks, or cargo-audit for advisory-only checks."
