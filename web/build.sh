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

# Parse command line arguments
NO_MINIFY=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --dev|--no-minify)
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

EXPECTED_NODE_VERSION="$(tr -d '[:space:]' < ../.nvmrc)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to build web assets. From the repo root, install and use the Node version in .nvmrc (e.g. 'nvm install && nvm use' or 'fnm install && fnm use')."
  exit 1
fi

PACKAGE_NODE_VERSION="$(node -p "const pkg = require('./package.json'); pkg.engines && pkg.engines.node ? pkg.engines.node : ''")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required to build web assets. From the repo root, install and use the Node version in .nvmrc (e.g. 'nvm install && nvm use' or 'fnm install && fnm use'), then retry the build."
  exit 1
fi

ACTIVE_NODE_VERSION="$(node --version | sed 's/^v//')"

if [[ -z "$PACKAGE_NODE_VERSION" ]]; then
  echo "Error: web/package.json is missing engines.node."
  exit 1
fi

if [[ "$PACKAGE_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Error: .nvmrc specifies Node.js $EXPECTED_NODE_VERSION but web/package.json engines.node is $PACKAGE_NODE_VERSION."
  echo "Update them together before building."
  exit 1
fi

if [[ "$ACTIVE_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Error: expected Node.js $EXPECTED_NODE_VERSION from .nvmrc, but found $ACTIVE_NODE_VERSION."
  echo "From the repo root, install and use the Node version in .nvmrc (e.g. 'nvm install && nvm use' or 'fnm install && fnm use'), then retry the build."
  exit 1
fi

rm -rf ./dist
npm ci --no-audit --no-fund

# Build with appropriate settings
if [ "$NO_MINIFY" = true ]; then
  echo "Building web assets in development mode:"
  echo "  - Minification: DISABLED"
  echo "  - Source maps: ENABLED"
  echo "  - Better stack traces and debugging"
  NO_MINIFY=true NODE_ENV=development npm run build
else
  echo "Building web assets in production mode:"
  echo "  - Minification: ENABLED"
  echo "  - Source maps: DISABLED"
  echo "  - Optimized for deployment"
  npm run build
fi

python3 generate_dist_handlers.py
rm -rf ../infumap/dist
mv dist ../infumap
# cp add.html ../infumap/dist
popd
