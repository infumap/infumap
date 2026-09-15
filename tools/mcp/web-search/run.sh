#!/usr/bin/env bash

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
readonly HOST="${WEB_SEARCH_HOST:-127.0.0.1}"
readonly PORT="${WEB_SEARCH_PORT:-8791}"
readonly RESTART_DELAY_SECS="${WEB_SEARCH_RESTART_DELAY_SECS:-5}"

BIN="${WEB_SEARCH_BIN:-}"
child_pid=""
shutdown_requested=0

fail() {
    echo "Error: $1" >&2
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

resolve_bin() {
    if [ -n "$BIN" ]; then
        [ -x "$BIN" ] || fail "WEB_SEARCH_BIN is not executable: $BIN"
        printf '%s\n' "$BIN"
        return 0
    fi

    local release_bin="$ROOT_DIR/target/release/infumap-web-search"
    if [ -x "$release_bin" ]; then
        printf '%s\n' "$release_bin"
        return 0
    fi

    command_exists cargo || fail "cargo was not found on PATH. Build infumap-web-search or set WEB_SEARCH_BIN."
    echo "Building infumap-web-search (release)" >&2
    cargo build --release --manifest-path "$ROOT_DIR/Cargo.toml"
    [ -x "$release_bin" ] || fail "Expected binary at $release_bin after cargo build"
    printf '%s\n' "$release_bin"
}

terminate_child() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0
    kill -TERM "$pid" 2>/dev/null || true
}

wait_for_child_shutdown() {
    local pid="${1:-}"
    local attempt
    [ -n "$pid" ] || return 0

    for attempt in 1 2 3 4 5; do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null || true
            return 0
        fi
        sleep 1
    done

    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    shutdown_requested=1
    terminate_child "$child_pid"
    wait_for_child_shutdown "$child_pid"
}

trap cleanup EXIT INT TERM

BIN="$(resolve_bin)"

echo "Starting Infumap web-search MCP server"
echo "Binary: $BIN"
echo "Listen: http://${HOST}:${PORT}/mcp"
echo "WEB_SEARCH_RESTART_DELAY_SECS=${RESTART_DELAY_SECS}"

export WEB_SEARCH_HOST="$HOST"
export WEB_SEARCH_PORT="$PORT"

while true; do
    "$BIN" &
    child_pid="$!"

    set +e
    wait "$child_pid"
    exit_code=$?
    set -e
    child_pid=""

    if [ "$shutdown_requested" -eq 1 ]; then
        exit 0
    fi

    echo "infumap-web-search exited with status ${exit_code}; restarting in ${RESTART_DELAY_SECS}s."
    sleep "$RESTART_DELAY_SECS"
done
