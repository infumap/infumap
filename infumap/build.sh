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

DEV_BUILD=0
EXTRA_ARGS=()
TARGET=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dev)
      DEV_BUILD=1
      shift
      ;;
    *)
      if [[ "$1" != -* && -z "$TARGET" ]]; then
        TARGET="$1"
      else
        EXTRA_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

pushd "$(dirname "$0")" >/dev/null

CARGO_ARGS=(build --locked)
if [[ $DEV_BUILD -eq 0 ]]; then
  CARGO_ARGS+=(--release)
fi
if [[ -n "$TARGET" ]]; then
  CARGO_ARGS+=(--target "$TARGET")
fi
CARGO_ARGS+=("${EXTRA_ARGS[@]}")

cargo "${CARGO_ARGS[@]}"
popd >/dev/null
