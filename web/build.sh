#!/bin/bash

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

# Parse command line arguments
NO_MINIFY=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-minify)
      NO_MINIFY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

pushd "$(dirname "$0")"
rm -rf ./dist
npm install

# Set NODE_ENV to development if --no-minify is specified
if [ "$NO_MINIFY" = true ]; then
  NODE_ENV=development npm run build
else
  npm run build
fi

python3 generate_dist_handlers.py
rm -rf ../infumap/dist
mv dist ../infumap
# cp add.html ../infumap/dist
popd
