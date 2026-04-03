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

WEB_BUILD_ARGS=()
INFUMAP_BUILD_ARGS=()
INCLUDE_ONNX=1
MINIFY_WEB=1
DEV_BUILD=0

print_usage() {
  cat <<'EOF'
Usage: ./build.sh [options] [target-triple]

Build the web client and Infumap server.
ONNX embedding support is included in the server build by default.

Options:
  --dev        Dev build: no web minification, no Rust optimizations (faster).
  --no-minify  Disable web minification for easier debugging.
  --no-onnx    Build the server without ONNX embedding support.
  -h, --help   Show this help.

Arguments:
  target-triple  Optional Rust target triple for the Infumap server build.
                 For backward compatibility, a bare positional argument is
                 treated as the target triple.
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      print_usage
      exit 0
      ;;
    --dev)
      DEV_BUILD=1
      MINIFY_WEB=0
      WEB_BUILD_ARGS+=(--dev)
      INFUMAP_BUILD_ARGS+=(--dev)
      shift
      ;;
    --no-minify)
      MINIFY_WEB=0
      WEB_BUILD_ARGS+=(--no-minify)
      shift
      ;;
    --no-onnx)
      INCLUDE_ONNX=0
      shift
      ;;
    *)
      INFUMAP_BUILD_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ $INCLUDE_ONNX -eq 1 ]]; then
  INFUMAP_BUILD_ARGS+=(--features=embed-onnx)
fi

echo "Build options:"
if [[ $DEV_BUILD -eq 1 ]]; then
  echo "  - Mode: dev (unoptimized, faster build)"
else
  echo "  - Mode: release (optimized)"
fi
if [[ $MINIFY_WEB -eq 1 ]]; then
  echo "  - Web minification: enabled"
else
  echo "  - Web minification: disabled"
fi

if [[ $INCLUDE_ONNX -eq 1 ]]; then
  echo "  - ONNX embedding support: enabled"
else
  echo "  - ONNX embedding support: disabled (--no-onnx)"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Warn if no server security audit has been run in the past week.
AUDIT_TIMESTAMP="$SCRIPT_DIR/.last-audit-server"
if [[ ! -f "$AUDIT_TIMESTAMP" ]]; then
  echo ""
  echo "  *** SECURITY AUDIT WARNING ***"
  echo "  No server security audit has been recorded for this repository."
  echo "  Run: ./audit.sh --server"
  echo ""
elif ! find "$AUDIT_TIMESTAMP" -mtime -7 -type f 2>/dev/null | grep -q .; then
  echo ""
  echo "  *** SECURITY AUDIT WARNING ***"
  echo "  Last server security audit was more than a week ago."
  echo "  Run: ./audit.sh --server"
  echo ""
fi

pushd "$SCRIPT_DIR"
./web/build.sh "${WEB_BUILD_ARGS[@]}"
./infumap/build.sh "${INFUMAP_BUILD_ARGS[@]}"
popd
