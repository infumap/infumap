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
readonly LOCAL_CARGO_HOME="$ROOT_DIR/.audit-cache/cargo"
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

skip() {
  echo "Skipping Rust audit: $1" >&2
  exit 2
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

prepare_local_cargo_home() {
  local source_cargo_home="$1"

  mkdir -p "$LOCAL_CARGO_HOME"

  if [[ ! -e "$LOCAL_CARGO_HOME/registry" && -d "$source_cargo_home/registry" ]]; then
    ln -s "$source_cargo_home/registry" "$LOCAL_CARGO_HOME/registry"
  fi

  if [[ ! -e "$LOCAL_CARGO_HOME/git" && -d "$source_cargo_home/git" ]]; then
    ln -s "$source_cargo_home/git" "$LOCAL_CARGO_HOME/git"
  fi

  if [[ ! -d "$LOCAL_CARGO_HOME/advisory-dbs" && -d "$source_cargo_home/advisory-dbs" ]]; then
    cp -a "$source_cargo_home/advisory-dbs" "$LOCAL_CARGO_HOME/"
  fi
}

run_cargo_deny() {
  local crate_dir=""
  local source_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  local deny_args=()

  prepare_local_cargo_home "$source_cargo_home"
  if [[ -d "$LOCAL_CARGO_HOME/advisory-dbs" ]]; then
    deny_args+=(--disable-fetch)
  fi

  for crate_dir in "${CRATE_DIRS[@]}"; do
    local manifest_path="$ROOT_DIR/$crate_dir/Cargo.toml"
    local deny_cmd=(
      cargo deny
      --manifest-path "$manifest_path"
      check
      "${deny_args[@]}"
      -A unmatched-source
    )
    ensure_lockfile "$crate_dir"

    if [[ "$crate_dir" == "infusdk" ]]; then
      # infusdk shares the top-level deny.toml, but some ignore entries only apply to infumap.
      deny_cmd+=(-A advisory-not-detected)
    fi

    deny_cmd+=(advisories bans sources)

    echo "Running cargo-deny for $crate_dir"
    CARGO_HOME="$LOCAL_CARGO_HOME" "${deny_cmd[@]}"
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

print_fix_guidance() {
  cat <<'EOF'

How to fix Rust vulnerabilities:
  For a vulnerable crate, update it to the fixed version:
    cd infumap && cargo update <crate-name> --precise <fixed-version>
    cd infusdk && cargo update <crate-name> --precise <fixed-version>
  Or relax the version constraint in Cargo.toml if needed, then run:
    cargo update <crate-name>
  Commit the updated Cargo.lock, then re-run ./audit.sh --server.

  If no fix is available yet and you need to suppress a known advisory:
    Add the advisory ID to deny.toml under [advisories] ignore:
      ignore = ["RUSTSEC-YYYY-NNNN"]
    Remove it from the ignore list once a fixed version is available.

  Install cargo-deny (preferred, checks advisories + sources + duplicates):
    cargo install cargo-deny
  Install cargo-audit (advisory checks only):
    cargo install cargo-audit
  (Run either command from any directory — cargo installs to ~/.cargo/bin/.)
EOF
}

audit_exit=0

if have_cargo_deny; then
  run_cargo_deny || audit_exit=$?
elif have_cargo_audit; then
  run_cargo_audit || audit_exit=$?
else
  skip "neither cargo-deny nor cargo-audit is installed.
  Run from any directory:
    cargo install cargo-deny   # preferred: checks advisories, sources, and duplicates
    cargo install cargo-audit  # advisory checks only
  cargo install places the binary in ~/.cargo/bin/ regardless of the current directory."
fi

if [[ "$audit_exit" -ne 0 ]]; then
  print_fix_guidance
  exit "$audit_exit"
fi

# Check publish-date age of all crates.io dependencies.
find_python() {
  for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf '%s' "$cmd"
      return 0
    fi
  done
  return 1
}

PYTHON=""
if PYTHON="$(find_python)"; then
  lock_paths=()
  for crate_dir in "${CRATE_DIRS[@]}"; do
    lock_paths+=("$ROOT_DIR/$crate_dir/Cargo.lock")
  done
  "$PYTHON" "$ROOT_DIR/check-crate-ages.py" "${lock_paths[@]}" || exit $?
else
  echo "Warning: Python not found; skipping crate publish-date age check." >&2
fi
