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

readonly HOST="${TEXT_EMBEDDING_HOST:-127.0.0.1}"
readonly PORT="${TEXT_EMBEDDING_PORT:-8789}"
readonly RESTART_DELAY_SECS="${TEXT_EMBEDDING_RESTART_DELAY_SECS:-5}"
readonly STARTUP_TIMEOUT_SECS="${TEXT_EMBEDDING_STARTUP_TIMEOUT_SECS:-900}"
readonly LLAMA_BIN_OVERRIDE="${TEXT_EMBEDDING_LLAMA_BIN:-}"
readonly HF_MODEL="${TEXT_EMBEDDING_HF_MODEL:-unsloth/embeddinggemma-300m-GGUF:Q8_0}"
readonly MODEL_PATH="${TEXT_EMBEDDING_MODEL_PATH:-}"
readonly LLAMA_CTX="${TEXT_EMBEDDING_LLAMA_CTX:-2048}"
readonly LLAMA_BATCH_SIZE="${TEXT_EMBEDDING_LLAMA_BATCH_SIZE:-2048}"
readonly LLAMA_UBATCH_SIZE="${TEXT_EMBEDDING_LLAMA_UBATCH_SIZE:-2048}"
readonly LLAMA_PARALLEL="${TEXT_EMBEDDING_LLAMA_PARALLEL:-1}"
readonly LLAMA_POOLING="${TEXT_EMBEDDING_LLAMA_POOLING:-last}"
readonly LLAMA_EXTRA_ARGS="${TEXT_EMBEDDING_LLAMA_EXTRA_ARGS:-}"

child_pid=""
LAUNCHED_CHILD_PID=""

fail() {
    echo "Error: $1" >&2
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
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

http_get_ok() {
    local url="$1"
    if command_exists curl; then
        curl -fsS --max-time 5 "$url" >/dev/null 2>&1
        return $?
    fi
    return 1
}

wait_for_llama_server() {
    local base_url="http://${HOST}:${PORT}"
    local deadline=$((SECONDS + STARTUP_TIMEOUT_SECS))

    while [ "$SECONDS" -lt "$deadline" ]; do
        if [ -n "$child_pid" ] && ! kill -0 "$child_pid" 2>/dev/null; then
            fail "llama-server exited before becoming ready at ${base_url}"
        fi
        if http_get_ok "${base_url}/health" || http_get_ok "${base_url}/v1/models"; then
            return 0
        fi
        sleep 1
    done

    fail "Timed out waiting for llama-server at ${base_url}"
}

cleanup() {
    if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
        terminate_child "$child_pid"
        wait_for_child_shutdown "$child_pid"
    fi
}

cleanup_and_exit() {
    cleanup
    exit 0
}

trap cleanup EXIT
trap cleanup_and_exit INT TERM

LLAMA_SERVER_BIN="$(ensure_local_llama_server)"
readonly LLAMA_SERVER_BIN
EFFECTIVE_LLAMA_NGL="$(effective_llama_ngl)"
readonly EFFECTIVE_LLAMA_NGL

echo "Starting Infumap text embedding service with llama-server"
echo "llama-server binary: $LLAMA_SERVER_BIN"
echo "Host/port: $HOST:$PORT"
if [ -n "$MODEL_PATH" ]; then
    echo "Model path: $MODEL_PATH"
else
    echo "Hugging Face model: $HF_MODEL"
fi
echo "llama ctx: $LLAMA_CTX"
echo "llama batch size: $LLAMA_BATCH_SIZE"
echo "llama ubatch size: $LLAMA_UBATCH_SIZE"
echo "llama parallel slots: $LLAMA_PARALLEL"
echo "llama pooling: $LLAMA_POOLING"
echo "llama n-gpu-layers: $EFFECTIVE_LLAMA_NGL"
echo "llama extra args: ${LLAMA_EXTRA_ARGS:-<unset>}"
echo "TEXT_EMBEDDING_RESTART_DELAY_SECS=${RESTART_DELAY_SECS}"
if has_nvidia_gpu; then
    echo "Detected GPUs via nvidia-smi:"
    nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader || true
elif is_macos; then
    echo "Detected Metal GPU (macOS)"
    system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model|VRAM" || true
else
    echo "nvidia-smi: not found"
fi

while true; do
    llama_cmd=(
        "$LLAMA_SERVER_BIN"
        --embedding
        --pooling "$LLAMA_POOLING"
        -c "$LLAMA_CTX"
        -b "$LLAMA_BATCH_SIZE"
        -ub "$LLAMA_UBATCH_SIZE"
        -np "$LLAMA_PARALLEL"
        --host "$HOST"
        --port "$PORT"
    )
    if [ -n "$MODEL_PATH" ]; then
        llama_cmd+=(-m "$MODEL_PATH")
    else
        llama_cmd+=(-hf "$HF_MODEL")
    fi
    if [ "$EFFECTIVE_LLAMA_NGL" != "0" ]; then
        llama_cmd+=(-ngl "$EFFECTIVE_LLAMA_NGL")
    fi
    if [ -n "$LLAMA_EXTRA_ARGS" ]; then
        # shellcheck disable=SC2206
        llama_extra_args=($LLAMA_EXTRA_ARGS)
        llama_cmd+=("${llama_extra_args[@]}")
    fi

    launch_child "${llama_cmd[@]}"
    child_pid="$LAUNCHED_CHILD_PID"
    wait_for_llama_server

    set +e
    wait "$child_pid"
    exit_code=$?
    set -e
    child_pid=""

    if [ "$exit_code" -eq 0 ]; then
        echo "Text embedding llama-server exited cleanly. Not restarting."
        exit 0
    fi

    if [ "$exit_code" -eq 139 ]; then
        echo "Text embedding llama-server crashed with SIGSEGV (exit 139). Restarting in ${RESTART_DELAY_SECS}s." >&2
    elif [ "$exit_code" -gt 128 ]; then
        echo "Text embedding llama-server exited due to signal $((exit_code - 128)) (exit ${exit_code}). Restarting in ${RESTART_DELAY_SECS}s." >&2
    else
        echo "Text embedding llama-server exited with status ${exit_code}. Restarting in ${RESTART_DELAY_SECS}s." >&2
    fi

    sleep "$RESTART_DELAY_SECS"
done
