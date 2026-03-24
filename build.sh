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

print_usage() {
  cat <<'EOF'
Usage: ./build.sh [options] [target-triple]

Build the web client and Infumap server.
ONNX embedding support is included in the server build by default.

Options:
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
    --no-minify)
      echo "🔧 Development build requested: disabling web minification for better debugging"
      WEB_BUILD_ARGS+=(--no-minify)
      shift
      ;;
    --no-onnx)
      echo "🔧 Building infumap without ONNX embedding support"
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
  INFUMAP_BUILD_ARGS+=(--features embed-onnx)
fi

pushd "$(dirname "$0")"
./web/build.sh "${WEB_BUILD_ARGS[@]}"
./infumap/build.sh "${INFUMAP_BUILD_ARGS[@]}"
popd
