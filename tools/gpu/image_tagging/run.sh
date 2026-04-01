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
readonly VENV_DIR="${IMAGE_TAGGING_VENV_DIR:-$ROOT_DIR/.venv}"
readonly HOST="${IMAGE_TAGGING_HOST:-127.0.0.1}"
readonly PORT="${IMAGE_TAGGING_PORT:-8788}"
readonly MANAGE_LLAMA_SERVER="${IMAGE_TAGGING_MANAGE_LLAMA_SERVER:-1}"
readonly LLAMA_HOST="${IMAGE_TAGGING_LLAMA_HOST:-127.0.0.1}"
readonly LLAMA_PORT="${IMAGE_TAGGING_LLAMA_PORT:-18080}"
readonly LLAMA_SERVER_URL_DEFAULT="http://${LLAMA_HOST}:${LLAMA_PORT}"
readonly STARTUP_TIMEOUT_SECS="${IMAGE_TAGGING_STARTUP_TIMEOUT_SECS:-900}"

readonly MODELS_DIR="${IMAGE_TAGGING_MODELS_DIR:-$ROOT_DIR/models}"
readonly MODEL_REPO="${IMAGE_TAGGING_MODEL_REPO:-unsloth/Qwen3.5-9B-GGUF}"
readonly MODEL_FILE="${IMAGE_TAGGING_MODEL_FILE:-Qwen3.5-9B-Q4_K_M.gguf}"
readonly MMPROJ_FILE="${IMAGE_TAGGING_MMPROJ_FILE:-mmproj-BF16.gguf}"
readonly IMAGE_EMBEDDING_ENABLED="${IMAGE_TAGGING_ENABLE_IMAGE_EMBEDDING:-1}"
readonly IMAGE_EMBEDDING_MODEL_ID="${IMAGE_TAGGING_EMBEDDING_MODEL_ID:-facebook/dinov2-with-registers-base}"
readonly MODEL_PATH="${MODELS_DIR}/${MODEL_FILE}"
readonly MMPROJ_PATH="${MODELS_DIR}/${MMPROJ_FILE}"

readonly LLAMA_CPP_REPO_URL="${IMAGE_TAGGING_LLAMA_CPP_REPO_URL:-https://github.com/ggml-org/llama.cpp.git}"
readonly LLAMA_CPP_DIR="${IMAGE_TAGGING_LLAMA_CPP_DIR:-$ROOT_DIR/.llama.cpp}"
readonly LLAMA_BUILD_DIR="${IMAGE_TAGGING_LLAMA_BUILD_DIR:-$LLAMA_CPP_DIR/build}"
readonly LLAMA_BIN_OVERRIDE="${IMAGE_TAGGING_LLAMA_BIN:-}"
readonly LLAMA_CMAKE_ARGS="${IMAGE_TAGGING_LLAMA_CMAKE_ARGS:-}"
readonly LLAMA_EXTRA_ARGS="${IMAGE_TAGGING_LLAMA_EXTRA_ARGS:-}"
readonly LLAMA_CTX="${IMAGE_TAGGING_LLAMA_CTX:-8192}"
readonly LLAMA_BATCH_SIZE="${IMAGE_TAGGING_LLAMA_BATCH_SIZE:-2048}"
readonly LLAMA_UBATCH_SIZE="${IMAGE_TAGGING_LLAMA_UBATCH_SIZE:-512}"
readonly LLAMA_PARALLEL="1"
readonly LLAMA_IMAGE_MIN_TOKENS="${IMAGE_TAGGING_LLAMA_IMAGE_MIN_TOKENS:-}"
readonly LLAMA_IMAGE_MAX_TOKENS="${IMAGE_TAGGING_LLAMA_IMAGE_MAX_TOKENS:-}"
readonly LLAMA_REASONING_FORMAT="${IMAGE_TAGGING_LLAMA_REASONING_FORMAT:-none}"
readonly LLAMA_UPDATE_CHECKOUT="${IMAGE_TAGGING_LLAMA_UPDATE_CHECKOUT:-0}"

llama_pid=""
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

require_command() {
    if ! command_exists "$1"; then
        fail "Required command not found: $1"
    fi
}

ensure_python_packages() {
    if "$VENV_PYTHON" -c "import fastapi, uvicorn, multipart, PIL, httpx, huggingface_hub, torch, torchvision, transformers" >/dev/null 2>&1; then
        return 0
    fi

    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install -r "$ROOT_DIR/requirements.txt"
}

has_nvidia_gpu() {
    command_exists nvidia-smi
}

effective_llama_ngl() {
    if [ -n "${IMAGE_TAGGING_LLAMA_NGL:-}" ]; then
        printf '%s\n' "${IMAGE_TAGGING_LLAMA_NGL}"
        return 0
    fi
    if has_nvidia_gpu; then
        printf '%s\n' "all"
        return 0
    fi
    printf '%s\n' "0"
}

effective_llama_flash_attn() {
    if [ -n "${IMAGE_TAGGING_LLAMA_FLASH_ATTN:-}" ]; then
        printf '%s\n' "${IMAGE_TAGGING_LLAMA_FLASH_ATTN}"
        return 0
    fi
    if has_nvidia_gpu; then
        printf '%s\n' "auto"
        return 0
    fi
    printf '%s\n' ""
}

ensure_llama_cpp_checkout() {
    if [ ! -d "$LLAMA_CPP_DIR/.git" ]; then
        require_command git
        git clone --depth 1 "$LLAMA_CPP_REPO_URL" "$LLAMA_CPP_DIR" >&2
        return 0
    fi

    if [ "$LLAMA_UPDATE_CHECKOUT" = "1" ]; then
        require_command git
        git -C "$LLAMA_CPP_DIR" pull --ff-only >&2
    fi
}

ensure_local_llama_server() {
    local candidate

    if [ -n "$LLAMA_BIN_OVERRIDE" ]; then
        [ -x "$LLAMA_BIN_OVERRIDE" ] || fail "IMAGE_TAGGING_LLAMA_BIN is not executable: $LLAMA_BIN_OVERRIDE"
        printf '%s\n' "$LLAMA_BIN_OVERRIDE"
        return 0
    fi

    if command_exists llama-server; then
        command -v llama-server
        return 0
    fi

    candidate="$LLAMA_BUILD_DIR/bin/llama-server"
    if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
    fi

    require_command git
    require_command cmake
    ensure_llama_cpp_checkout

    local jobs
    jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

    local -a cmake_configure_args
    cmake_configure_args=(
        -S "$LLAMA_CPP_DIR"
        -B "$LLAMA_BUILD_DIR"
        -DCMAKE_BUILD_TYPE=Release
    )
    if has_nvidia_gpu; then
        cmake_configure_args+=(-DGGML_CUDA=ON)
    fi
    if [ -n "$LLAMA_CMAKE_ARGS" ]; then
        local -a extra_cmake_args
        # shellcheck disable=SC2206
        extra_cmake_args=($LLAMA_CMAKE_ARGS)
        cmake_configure_args+=("${extra_cmake_args[@]}")
    fi

    echo "Configuring llama.cpp build in $LLAMA_BUILD_DIR" >&2
    cmake "${cmake_configure_args[@]}" >&2
    echo "Building llama-server with $jobs job(s)" >&2
    cmake --build "$LLAMA_BUILD_DIR" --config Release -j "$jobs" --target llama-server >&2

    [ -x "$candidate" ] || fail "Expected llama-server binary was not produced at $candidate"
    printf '%s\n' "$candidate"
}

ensure_models() {
    mkdir -p "$MODELS_DIR"
    "$VENV_PYTHON" "$ROOT_DIR/bootstrap_models.py" \
        --repo-id "$MODEL_REPO" \
        --model-file "$MODEL_FILE" \
        --mmproj-file "$MMPROJ_FILE" \
        --dest-dir "$MODELS_DIR"
}

wait_for_llama_server() {
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

def process_alive(pid: int | None) -> bool:
    if pid is None:
        return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

while time.time() < deadline:
    if not process_alive(server_pid):
        print(f"llama-server exited before becoming ready at {base_url}", file=sys.stderr)
        sys.exit(1)
    for path in paths:
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

if [ ! -x "$VENV_DIR/bin/python" ]; then
    create_venv
fi

readonly VENV_PYTHON="$VENV_DIR/bin/python"

ensure_venv_pip
ensure_python_packages

if [ "$MANAGE_LLAMA_SERVER" = "1" ]; then
    export IMAGE_TAGGING_LLAMA_SERVER_URL="$LLAMA_SERVER_URL_DEFAULT"
else
    export IMAGE_TAGGING_LLAMA_SERVER_URL="${IMAGE_TAGGING_LLAMA_SERVER_URL:-$LLAMA_SERVER_URL_DEFAULT}"
fi
export IMAGE_TAGGING_ENABLE_IMAGE_EMBEDDING="$IMAGE_EMBEDDING_ENABLED"
export IMAGE_TAGGING_EMBEDDING_MODEL_ID="$IMAGE_EMBEDDING_MODEL_ID"
export IMAGE_TAGGING_MODEL_REPO="$MODEL_REPO"
export IMAGE_TAGGING_MODEL_FILE="$MODEL_FILE"
export IMAGE_TAGGING_MODEL_ID="${IMAGE_TAGGING_MODEL_ID:-${MODEL_REPO}:${MODEL_FILE}}"
export IMAGE_TAGGING_LLAMA_MODEL_NAME="${IMAGE_TAGGING_LLAMA_MODEL_NAME:-${MODEL_FILE%.gguf}}"
export IMAGE_TAGGING_MAX_CONCURRENCY="1"

echo "Starting Infumap image tagging service"
echo "Python: $("$VENV_PYTHON" -V 2>&1)"
echo "API host/port: $HOST:$PORT"
echo "llama-server URL: $IMAGE_TAGGING_LLAMA_SERVER_URL"
echo "Model repo: $MODEL_REPO"
echo "Model file: $MODEL_FILE"
echo "mmproj file: $MMPROJ_FILE"
echo "Image embedding enabled: $IMAGE_EMBEDDING_ENABLED"
echo "Image embedding model: $IMAGE_EMBEDDING_MODEL_ID"
echo "IMAGE_TAGGING_MAX_CONCURRENCY=${IMAGE_TAGGING_MAX_CONCURRENCY}"

if has_nvidia_gpu; then
    echo "Detected GPUs via nvidia-smi:"
    nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader || true
else
    echo "nvidia-smi: not found"
fi

if [ "$MANAGE_LLAMA_SERVER" = "1" ]; then
    readonly LLAMA_SERVER_BIN="$(ensure_local_llama_server)"
    ensure_models

    readonly EFFECTIVE_LLAMA_NGL="$(effective_llama_ngl)"
    readonly EFFECTIVE_LLAMA_FLASH_ATTN="$(effective_llama_flash_attn)"

    echo "llama-server binary: $LLAMA_SERVER_BIN"
    echo "Local llama.cpp checkout: $LLAMA_CPP_DIR"
    echo "Local models dir: $MODELS_DIR"
    echo "llama ctx: $LLAMA_CTX"
    echo "llama batch size: $LLAMA_BATCH_SIZE"
    echo "llama ubatch size: $LLAMA_UBATCH_SIZE"
    echo "llama parallel slots: $LLAMA_PARALLEL"
    echo "llama n-gpu-layers: $EFFECTIVE_LLAMA_NGL"
    echo "llama flash-attn: ${EFFECTIVE_LLAMA_FLASH_ATTN:-<unset>}"
    echo "llama image min tokens: ${LLAMA_IMAGE_MIN_TOKENS:-<unset>}"
    echo "llama image max tokens: ${LLAMA_IMAGE_MAX_TOKENS:-<unset>}"
    echo "llama reasoning format: ${LLAMA_REASONING_FORMAT:-<unset>}"

    llama_cmd=(
        "$LLAMA_SERVER_BIN"
        -m "$MODEL_PATH"
        --mmproj "$MMPROJ_PATH"
        -c "$LLAMA_CTX"
        -b "$LLAMA_BATCH_SIZE"
        -ub "$LLAMA_UBATCH_SIZE"
        -np "$LLAMA_PARALLEL"
        --host "$LLAMA_HOST"
        --port "$LLAMA_PORT"
    )
    if [ "$EFFECTIVE_LLAMA_NGL" != "0" ]; then
        llama_cmd+=(-ngl "$EFFECTIVE_LLAMA_NGL")
    fi
    if [ -n "$EFFECTIVE_LLAMA_FLASH_ATTN" ]; then
        llama_cmd+=(-fa "$EFFECTIVE_LLAMA_FLASH_ATTN")
    fi
    if [ -n "$LLAMA_IMAGE_MIN_TOKENS" ]; then
        llama_cmd+=(--image-min-tokens "$LLAMA_IMAGE_MIN_TOKENS")
    fi
    if [ -n "$LLAMA_IMAGE_MAX_TOKENS" ]; then
        llama_cmd+=(--image-max-tokens "$LLAMA_IMAGE_MAX_TOKENS")
    fi
    if [ -n "$LLAMA_REASONING_FORMAT" ]; then
        llama_cmd+=(--reasoning-format "$LLAMA_REASONING_FORMAT")
    fi
    if [ -n "$LLAMA_EXTRA_ARGS" ]; then
        # shellcheck disable=SC2206
        llama_extra_args=($LLAMA_EXTRA_ARGS)
        llama_cmd+=("${llama_extra_args[@]}")
    fi

    launch_child "${llama_cmd[@]}"
    llama_pid="$LAUNCHED_CHILD_PID"

    echo "Waiting for llama-server to become ready..."
    wait_for_llama_server "$IMAGE_TAGGING_LLAMA_SERVER_URL" "$llama_pid"
else
    echo "Using externally managed llama-server at $IMAGE_TAGGING_LLAMA_SERVER_URL"
fi

launch_child "$VENV_PYTHON" -m uvicorn app:app --app-dir "$ROOT_DIR" --host "$HOST" --port "$PORT"
api_pid="$LAUNCHED_CHILD_PID"

set +e
if [ -n "$llama_pid" ]; then
    wait_for_first_child_exit "$api_pid" "$llama_pid"
else
    wait "$api_pid"
fi
exit_code=$?
set -e

exit "$exit_code"
