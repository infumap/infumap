#!/usr/bin/env bash

set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
readonly VENV_DIR="${IMAGE_TAGGING_VENV_DIR:-$ROOT_DIR/.venv}"
readonly HOST="${IMAGE_TAGGING_HOST:-127.0.0.1}"
readonly PORT="${IMAGE_TAGGING_PORT:-8788}"
export IMAGE_TAGGING_MODEL_ID="${IMAGE_TAGGING_MODEL_ID:-microsoft/Florence-2-large-ft}"
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

gpu_total_memory_mib() {
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        return 1
    fi
    nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1
}

set_runtime_defaults() {
    local gpu_mib=""
    if gpu_mib="$(gpu_total_memory_mib)" && [ -n "$gpu_mib" ]; then
        if [ -z "${TORCH_DEVICE:-}" ]; then
            export TORCH_DEVICE="cuda"
        fi
    fi

    if [ -z "${IMAGE_TAGGING_MAX_CONCURRENCY:-}" ]; then
        export IMAGE_TAGGING_MAX_CONCURRENCY=1
    fi
}

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

if ! "$VENV_PYTHON" -m pip show torch >/dev/null 2>&1 \
    || ! "$VENV_PYTHON" -m pip show transformers >/dev/null 2>&1 \
    || ! "$VENV_PYTHON" -m pip show fastapi >/dev/null 2>&1 \
    || ! "$VENV_PYTHON" -m pip show uvicorn >/dev/null 2>&1 \
    || ! "$VENV_PYTHON" -m pip show python-multipart >/dev/null 2>&1 \
    || ! "$VENV_PYTHON" -m pip show Pillow >/dev/null 2>&1 \
    || ! "$VENV_PYTHON" -m pip show timm >/dev/null 2>&1; then
    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install --upgrade torch transformers fastapi uvicorn python-multipart Pillow timm
fi

set_runtime_defaults

echo "Starting Infumap image tagging service"
echo "Python: $("$VENV_PYTHON" -V 2>&1)"
echo "Host/port: $HOST:$PORT"
echo "Model: $IMAGE_TAGGING_MODEL_ID"
echo "TORCH_DEVICE=${TORCH_DEVICE:-<unset>}"
echo "CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-<unset>}"
echo "PYTORCH_CUDA_ALLOC_CONF=${PYTORCH_CUDA_ALLOC_CONF}"
echo "IMAGE_TAGGING_MAX_CONCURRENCY=${IMAGE_TAGGING_MAX_CONCURRENCY}"
if command -v nvidia-smi >/dev/null 2>&1; then
    echo "Detected GPUs via nvidia-smi:"
    nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader || true
else
    echo "nvidia-smi: not found"
fi

exec "$VENV_PYTHON" -m uvicorn app:app --app-dir "$ROOT_DIR" --host "$HOST" --port "$PORT"
