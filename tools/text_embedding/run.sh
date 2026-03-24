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
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
readonly VENV_DIR="${TEXT_EMBEDDING_VENV_DIR:-$ROOT_DIR/.venv}"
readonly HOST="${TEXT_EMBEDDING_HOST:-127.0.0.1}"
readonly PORT="${TEXT_EMBEDDING_PORT:-8789}"
readonly RESTART_DELAY_SECS="${TEXT_EMBEDDING_RESTART_DELAY_SECS:-5}"
readonly FASTEMBED_PACKAGE="${TEXT_EMBEDDING_FASTEMBED_PACKAGE:-fastembed}"
export TEXT_EMBEDDING_MODELS_DIR="${TEXT_EMBEDDING_MODELS_DIR:-$ROOT_DIR/models}"

fail() {
    echo "Error: $1" >&2
    exit 1
}

venv_package_name() {
    "$PYTHON_BIN" - <<'PY'
import sys
print(f"python{sys.version_info.major}.{sys.version_info.minor}-venv")
PY
}

create_venv() {
    local output_file
    output_file="$(mktemp)"

    if "$PYTHON_BIN" -m venv "$VENV_DIR" >"$output_file" 2>&1; then
        rm -f "$output_file"
        return 0
    fi

    rm -rf "$VENV_DIR"

    if ! "$PYTHON_BIN" -m ensurepip --version >/dev/null 2>&1; then
        local package_name
        package_name="$(venv_package_name)"
        echo "Python virtualenv bootstrap support is missing." >&2
        echo "Install it with one of:" >&2
        echo "  sudo apt install $package_name" >&2
        echo "  sudo apt install python3-venv" >&2
        echo "" >&2
    fi

    cat "$output_file" >&2
    rm -f "$output_file"
    exit 1
}

ensure_venv_pip() {
    if "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
        return 0
    fi

    if "$VENV_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1; then
        return 0
    fi

    rm -rf "$VENV_DIR"
    create_venv

    if "$VENV_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1; then
        return 0
    fi

    local package_name
    package_name="$(venv_package_name)"
    fail "pip is unavailable inside the virtualenv. Install $package_name or python3-venv, then rerun."
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    fail "Python executable not found: $PYTHON_BIN"
fi

if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
    fail "python venv support is required. On Debian this is usually provided by python3-venv."
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
    create_venv
fi

readonly VENV_PYTHON="$VENV_DIR/bin/python"
ensure_venv_pip

if ! "$VENV_PYTHON" -c "import fastapi, uvicorn, fastembed" >/dev/null 2>&1; then
    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install --upgrade fastapi uvicorn "$FASTEMBED_PACKAGE"
fi

mkdir -p "$TEXT_EMBEDDING_MODELS_DIR"

echo "Starting Infumap text embedding service"
echo "Python: $("$VENV_PYTHON" -V 2>&1)"
echo "Host/port: $HOST:$PORT"
echo "TEXT_EMBEDDING_MODELS_DIR=${TEXT_EMBEDDING_MODELS_DIR}"
echo "TEXT_EMBEDDING_FASTEMBED_PACKAGE=${FASTEMBED_PACKAGE}"
echo "TEXT_EMBEDDING_MAX_BATCH_ITEMS=${TEXT_EMBEDDING_MAX_BATCH_ITEMS:-256}"
echo "TEXT_EMBEDDING_MAX_TEXT_CHARS=${TEXT_EMBEDDING_MAX_TEXT_CHARS:-32768}"
echo "TEXT_EMBEDDING_MAX_CONCURRENCY=${TEXT_EMBEDDING_MAX_CONCURRENCY:-1}"
echo "TEXT_EMBEDDING_PROVIDERS=${TEXT_EMBEDDING_PROVIDERS:-<default>}"
echo "TEXT_EMBEDDING_RESTART_DELAY_SECS=${RESTART_DELAY_SECS}"
if command -v nvidia-smi >/dev/null 2>&1; then
    echo "Detected GPUs via nvidia-smi:"
    nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader || true
else
    echo "nvidia-smi: not found"
fi

child_pid=""
shutdown_requested=0
restart_count=0

stop_supervisor() {
    shutdown_requested=1
    if [ -n "${child_pid}" ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
    fi
}

trap stop_supervisor INT TERM

while true; do
    "$VENV_PYTHON" -m uvicorn app:app --app-dir "$ROOT_DIR" --host "$HOST" --port "$PORT" &
    child_pid="$!"

    set +e
    wait "$child_pid"
    exit_code=$?
    set -e

    child_pid=""

    if [ "$shutdown_requested" -eq 1 ]; then
        exit 0
    fi

    if [ "$exit_code" -eq 0 ]; then
        echo "Text embedding service exited cleanly. Not restarting."
        exit 0
    fi

    restart_count="$((restart_count + 1))"
    if [ "$exit_code" -eq 139 ]; then
        echo "Text embedding service crashed with SIGSEGV (exit 139). Restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})." >&2
    elif [ "$exit_code" -gt 128 ]; then
        echo "Text embedding service exited due to signal $((exit_code - 128)) (exit ${exit_code}). Restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})." >&2
    else
        echo "Text embedding service exited with status ${exit_code}. Restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})." >&2
    fi

    sleep "$RESTART_DELAY_SECS"
done
