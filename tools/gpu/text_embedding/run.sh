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
readonly GPU_ROOT_DIR="$(cd "$ROOT_DIR/.." && pwd)"
readonly VENV_DIR="${TEXT_EMBEDDING_VENV_DIR:-$ROOT_DIR/.venv}"
source "$GPU_ROOT_DIR/python_runtime.sh"
PYTHON_BIN="$(select_gpu_python_bin "$VENV_DIR")"
readonly PYTHON_BIN
readonly HOST="${TEXT_EMBEDDING_HOST:-127.0.0.1}"
readonly PORT="${TEXT_EMBEDDING_PORT:-8789}"
readonly LLAMA_HOST="${TEXT_EMBEDDING_LLAMA_HOST:-127.0.0.1}"
readonly LLAMA_PORT="${TEXT_EMBEDDING_LLAMA_PORT:-18089}"
readonly LLAMA_SERVER_URL_DEFAULT="http://${LLAMA_HOST}:${LLAMA_PORT}"
readonly STARTUP_TIMEOUT_SECS="${TEXT_EMBEDDING_STARTUP_TIMEOUT_SECS:-900}"
readonly LLAMA_BIN_OVERRIDE="${TEXT_EMBEDDING_LLAMA_BIN:-}"
readonly MODEL_ID="Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"
readonly LLAMA_CTX="${TEXT_EMBEDDING_LLAMA_CTX:-32768}"
readonly LLAMA_BATCH_SIZE="${TEXT_EMBEDDING_LLAMA_BATCH_SIZE:-8192}"
readonly LLAMA_UBATCH_SIZE="${TEXT_EMBEDDING_LLAMA_UBATCH_SIZE:-8192}"
readonly LLAMA_PARALLEL="${TEXT_EMBEDDING_LLAMA_PARALLEL:-1}"
readonly LLAMA_POOLING="${TEXT_EMBEDDING_LLAMA_POOLING:-last}"

llama_pid=""
api_pid=""
LAUNCHED_CHILD_PID=""

fail() {
    echo "Error: $1" >&2
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
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

ensure_python_packages() {
    if "$VENV_PYTHON" -c "import fastapi, uvicorn, httpx" >/dev/null 2>&1; then
        return 0
    fi

    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install -r "$ROOT_DIR/requirements.txt"
}

is_macos() {
    [ "$(uname -s)" = "Darwin" ]
}

has_nvidia_gpu() {
    command_exists nvidia-smi
}

has_gpu_acceleration() {
    has_nvidia_gpu || is_macos
}

effective_llama_ngl() {
    if [ -n "${TEXT_EMBEDDING_LLAMA_NGL:-}" ]; then
        printf '%s\n' "${TEXT_EMBEDDING_LLAMA_NGL}"
        return 0
    fi
    if has_gpu_acceleration; then
        printf '%s\n' "all"
        return 0
    fi
    printf '%s\n' "0"
}

ensure_local_llama_server() {
    if [ -n "$LLAMA_BIN_OVERRIDE" ]; then
        [ -x "$LLAMA_BIN_OVERRIDE" ] || fail "TEXT_EMBEDDING_LLAMA_BIN is not executable: $LLAMA_BIN_OVERRIDE"
        printf '%s\n' "$LLAMA_BIN_OVERRIDE"
        return 0
    fi

    if command_exists llama-server; then
        command -v llama-server
        return 0
    fi

    fail "llama-server was not found on PATH. Install llama.cpp or set TEXT_EMBEDDING_LLAMA_BIN=/path/to/llama-server."
}

launch_child() {
    if command_exists setsid; then
        setsid "$@" &
    else
        "$@" &
    fi
    LAUNCHED_CHILD_PID="$!"
}

terminate_child() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0

    if command_exists setsid; then
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        return 0
    fi

    if command_exists pkill; then
        pkill -TERM -P "$pid" 2>/dev/null || true
    fi
    kill -TERM "$pid" 2>/dev/null || true
}

force_kill_child() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0

    if command_exists setsid; then
        kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        return 0
    fi

    if command_exists pkill; then
        pkill -KILL -P "$pid" 2>/dev/null || true
    fi
    kill -KILL "$pid" 2>/dev/null || true
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

    force_kill_child "$pid"
    wait "$pid" 2>/dev/null || true
}

wait_for_llama_server() {
    local server_url="$1"
    local server_pid="$2"

    "$VENV_PYTHON" - "$server_url" "$STARTUP_TIMEOUT_SECS" "$server_pid" <<'PY'
import os
import sys
import time
import urllib.request

base_url = sys.argv[1].rstrip("/")
deadline = time.time() + float(sys.argv[2])
server_pid = int(sys.argv[3])

while time.time() < deadline:
    try:
        os.kill(server_pid, 0)
    except OSError:
        print(f"llama-server exited before becoming ready at {base_url}", file=sys.stderr)
        sys.exit(1)

    for path in ("/health", "/v1/models", "/"):
        try:
            with urllib.request.urlopen(base_url + path, timeout=5) as response:
                if 200 <= response.status < 400:
                    sys.exit(0)
        except Exception:
            pass
    time.sleep(1)

print(f"Timed out waiting for llama-server at {base_url}", file=sys.stderr)
sys.exit(1)
PY
}

cleanup() {
    if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
        terminate_child "$api_pid"
    fi
    if [ -n "$llama_pid" ] && kill -0 "$llama_pid" 2>/dev/null; then
        terminate_child "$llama_pid"
    fi
    wait_for_child_shutdown "$api_pid"
    wait_for_child_shutdown "$llama_pid"
}

supports_wait_n() {
    local major="${BASH_VERSINFO[0]:-0}"
    local minor="${BASH_VERSINFO[1]:-0}"
    if [ "$major" -gt 4 ]; then
        return 0
    fi
    if [ "$major" -eq 4 ] && [ "$minor" -ge 3 ]; then
        return 0
    fi
    return 1
}

wait_for_first_child_exit() {
    local first_pid="$1"
    local second_pid="$2"

    if supports_wait_n; then
        wait -n "$first_pid" "$second_pid"
        return $?
    fi

    while true; do
        if ! kill -0 "$first_pid" 2>/dev/null; then
            wait "$first_pid"
            return $?
        fi
        if ! kill -0 "$second_pid" 2>/dev/null; then
            wait "$second_pid"
            return $?
        fi
        sleep 1
    done
}

trap cleanup EXIT INT TERM

if ! command_exists "$PYTHON_BIN"; then
    fail "Python executable not found: $PYTHON_BIN"
fi

if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
    fail "python venv support is required. On Debian this is usually provided by python3-venv."
fi

ensure_gpu_venv_python "$VENV_DIR" "$PYTHON_BIN"

if [ ! -x "$VENV_DIR/bin/python" ]; then
    create_venv
fi

readonly VENV_PYTHON="$VENV_DIR/bin/python"

ensure_venv_pip
ensure_python_packages

readonly LLAMA_SERVER_BIN="$(ensure_local_llama_server)"
readonly EFFECTIVE_LLAMA_NGL="$(effective_llama_ngl)"

echo "Starting Infumap text embedding service"
echo "Python: $("$VENV_PYTHON" -V 2>&1)"
echo "API host/port: $HOST:$PORT"
echo "llama-server URL: $LLAMA_SERVER_URL_DEFAULT"
echo "llama-server binary: $LLAMA_SERVER_BIN"
echo "Hugging Face model: $MODEL_ID"
echo "llama ctx: $LLAMA_CTX"
echo "llama batch size: $LLAMA_BATCH_SIZE"
echo "llama ubatch size: $LLAMA_UBATCH_SIZE"
echo "llama parallel slots: $LLAMA_PARALLEL"
echo "llama pooling: $LLAMA_POOLING"
echo "llama n-gpu-layers: $EFFECTIVE_LLAMA_NGL"
if has_nvidia_gpu; then
    echo "Detected GPUs via nvidia-smi:"
    nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader || true
elif is_macos; then
    echo "Detected Metal GPU (macOS)"
    system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model|VRAM" || true
else
    echo "nvidia-smi: not found"
fi

llama_cmd=(
    "$LLAMA_SERVER_BIN"
    --embedding
    --pooling "$LLAMA_POOLING"
    -c "$LLAMA_CTX"
    -b "$LLAMA_BATCH_SIZE"
    -ub "$LLAMA_UBATCH_SIZE"
    -np "$LLAMA_PARALLEL"
    --host "$LLAMA_HOST"
    --port "$LLAMA_PORT"
    -hf "$MODEL_ID"
)
if [ "$EFFECTIVE_LLAMA_NGL" != "0" ]; then
    llama_cmd+=(-ngl "$EFFECTIVE_LLAMA_NGL")
fi

launch_child "${llama_cmd[@]}"
llama_pid="$LAUNCHED_CHILD_PID"

echo "Waiting for llama-server to become ready..."
wait_for_llama_server "$LLAMA_SERVER_URL_DEFAULT" "$llama_pid"

launch_child "$VENV_PYTHON" -m uvicorn app:app --app-dir "$ROOT_DIR" --host "$HOST" --port "$PORT"
api_pid="$LAUNCHED_CHILD_PID"

set +e
wait_for_first_child_exit "$api_pid" "$llama_pid"
exit_code=$?
set -e

exit "$exit_code"
