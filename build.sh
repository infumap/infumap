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

WEB_BUILD_ARGS=""
INFUMAP_BUILD_ARGS=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-minify)
      echo "🔧 Development build requested: disabling web minification for better debugging"
      WEB_BUILD_ARGS="--no-minify"
      shift
      ;;
    *)
      INFUMAP_BUILD_ARGS="$INFUMAP_BUILD_ARGS $1"
      shift
      ;;
  esac
done

pushd "$(dirname "$0")"
./web/build.sh $WEB_BUILD_ARGS
./infumap/build.sh $INFUMAP_BUILD_ARGS
popd
