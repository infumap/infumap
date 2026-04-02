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

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Error: image_tagging_mlx requires macOS (MLX is Apple-only)." >&2
    exit 1
fi

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
readonly VENV_DIR="${IMAGE_TAGGING_VENV_DIR:-$ROOT_DIR/.venv}"
readonly HOST="${IMAGE_TAGGING_HOST:-127.0.0.1}"
readonly PORT="${IMAGE_TAGGING_PORT:-8788}"
readonly MANAGE_MLX_SERVER="${IMAGE_TAGGING_MANAGE_MLX_SERVER:-1}"
readonly MLX_HOST="${IMAGE_TAGGING_MLX_HOST:-127.0.0.1}"
readonly MLX_PORT="${IMAGE_TAGGING_MLX_PORT:-18080}"
readonly MLX_SERVER_URL_DEFAULT="http://${MLX_HOST}:${MLX_PORT}"
readonly STARTUP_TIMEOUT_SECS="${IMAGE_TAGGING_STARTUP_TIMEOUT_SECS:-900}"

readonly MODELS_DIR="${IMAGE_TAGGING_MODELS_DIR:-$ROOT_DIR/models}"
readonly MODEL_REPO="${IMAGE_TAGGING_MODEL_REPO:-mlx-community/Qwen2.5-VL-7B-Instruct-4bit}"
readonly MODEL_DIR_NAME="${MODEL_REPO##*/}"
readonly MODEL_PATH="${MODELS_DIR}/${MODEL_DIR_NAME}"
readonly IMAGE_EMBEDDING_ENABLED="${IMAGE_TAGGING_ENABLE_IMAGE_EMBEDDING:-1}"
readonly IMAGE_EMBEDDING_MODEL_ID="${IMAGE_TAGGING_EMBEDDING_MODEL_ID:-facebook/dinov2-with-registers-base}"

readonly MLX_EXTRA_ARGS="${IMAGE_TAGGING_MLX_EXTRA_ARGS:-}"

mlx_pid=""
api_pid=""
LAUNCHED_CHILD_PID=""

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
        echo "  brew install python3" >&2
        echo "  sudo apt install $package_name" >&2
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

command_exists() {
    command -v "$1" >/dev/null 2>&1
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

ensure_python_packages() {
    if "$VENV_PYTHON" -c "import fastapi, uvicorn, multipart, PIL, httpx, huggingface_hub, mlx_vlm, torch, torchvision, transformers" >/dev/null 2>&1; then
        return 0
    fi

    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install -r "$ROOT_DIR/requirements.txt"
}

ensure_models() {
    mkdir -p "$MODELS_DIR"
    "$VENV_PYTHON" "$ROOT_DIR/bootstrap_models.py" \
        --repo-id "$MODEL_REPO" \
        --dest-dir "$MODEL_PATH"
}

wait_for_mlx_server() {
    local server_url
    server_url="$1"
    local server_pid
    server_pid="${2:-}"

    "$VENV_PYTHON" - "$server_url" "$STARTUP_TIMEOUT_SECS" "$server_pid" <<'PY'
import os
import sys
import time
import urllib.error
import urllib.request

base_url = sys.argv[1].rstrip("/")
deadline = time.time() + float(sys.argv[2])
pid_text = sys.argv[3].strip()
server_pid = int(pid_text) if pid_text else None
paths = ("/health", "/v1/models", "/")

def process_alive(pid):
    if pid is None:
        return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

while time.time() < deadline:
    if not process_alive(server_pid):
        print(f"mlx-vlm server exited before becoming ready at {base_url}", file=sys.stderr)
        sys.exit(1)
    for path in paths:
        try:
            with urllib.request.urlopen(base_url + path, timeout=5) as response:
                if 200 <= response.status < 400:
                    sys.exit(0)
        except Exception:
            pass
    time.sleep(1)

print(f"Timed out waiting for mlx-vlm server at {base_url}", file=sys.stderr)
sys.exit(1)
PY
}

cleanup() {
    if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
        terminate_child "$api_pid"
    fi
    if [ -n "$mlx_pid" ] && kill -0 "$mlx_pid" 2>/dev/null; then
        terminate_child "$mlx_pid"
    fi
    wait_for_child_shutdown "$api_pid"
    wait_for_child_shutdown "$mlx_pid"
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
    fail "python venv support is required. On macOS: brew install python3"
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
    create_venv
fi

readonly VENV_PYTHON="$VENV_DIR/bin/python"

ensure_venv_pip
ensure_python_packages

if [ "$MANAGE_MLX_SERVER" = "1" ]; then
    export IMAGE_TAGGING_MLX_SERVER_URL="$MLX_SERVER_URL_DEFAULT"
else
    export IMAGE_TAGGING_MLX_SERVER_URL="${IMAGE_TAGGING_MLX_SERVER_URL:-$MLX_SERVER_URL_DEFAULT}"
fi
export IMAGE_TAGGING_ENABLE_IMAGE_EMBEDDING="$IMAGE_EMBEDDING_ENABLED"
export IMAGE_TAGGING_EMBEDDING_MODEL_ID="$IMAGE_EMBEDDING_MODEL_ID"
export IMAGE_TAGGING_MODEL_REPO="$MODEL_REPO"
export IMAGE_TAGGING_MODEL_ID="${IMAGE_TAGGING_MODEL_ID:-${MODEL_PATH}}"
export IMAGE_TAGGING_MLX_MODEL_NAME="${IMAGE_TAGGING_MLX_MODEL_NAME:-${MODEL_PATH}}"
export IMAGE_TAGGING_MAX_CONCURRENCY="1"

echo "Starting Infumap image tagging service (MLX)"
echo "Python: $("$VENV_PYTHON" -V 2>&1)"
echo "API host/port: $HOST:$PORT"
echo "mlx-vlm server URL: $IMAGE_TAGGING_MLX_SERVER_URL"
echo "Model repo: $MODEL_REPO"
echo "Model path: $MODEL_PATH"
echo "Image embedding enabled: $IMAGE_EMBEDDING_ENABLED"
echo "Image embedding model: $IMAGE_EMBEDDING_MODEL_ID"
echo "IMAGE_TAGGING_MAX_CONCURRENCY=${IMAGE_TAGGING_MAX_CONCURRENCY}"
echo "GPU: $(system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model" | head -1 | sed 's/.*: //' || echo 'unknown')"

if [ "$MANAGE_MLX_SERVER" = "1" ]; then
    ensure_models

    mlx_cmd=(
        "$VENV_PYTHON" -m mlx_vlm.server
        --model "$MODEL_PATH"
        --host "$MLX_HOST"
        --port "$MLX_PORT"
    )
    if [ -n "$MLX_EXTRA_ARGS" ]; then
        local -a mlx_extra_args
        # shellcheck disable=SC2206
        mlx_extra_args=($MLX_EXTRA_ARGS)
        mlx_cmd+=("${mlx_extra_args[@]}")
    fi

    echo "Launching mlx-vlm server: ${mlx_cmd[*]}"
    launch_child "${mlx_cmd[@]}"
    mlx_pid="$LAUNCHED_CHILD_PID"

    echo "Waiting for mlx-vlm server to become ready..."
    wait_for_mlx_server "$IMAGE_TAGGING_MLX_SERVER_URL" "$mlx_pid"
else
    echo "Using externally managed mlx-vlm server at $IMAGE_TAGGING_MLX_SERVER_URL"
fi

launch_child "$VENV_PYTHON" -m uvicorn app:app --app-dir "$ROOT_DIR" --host "$HOST" --port "$PORT"
api_pid="$LAUNCHED_CHILD_PID"

set +e
if [ -n "$mlx_pid" ]; then
    wait_for_first_child_exit "$api_pid" "$mlx_pid"
else
    wait "$api_pid"
fi
exit_code=$?
set -e

exit "$exit_code"
