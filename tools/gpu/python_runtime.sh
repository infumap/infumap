# Common Python runtime helpers for GPU service launchers.

readonly GPU_PYTHON_MIN_MAJOR="${GPU_PYTHON_MIN_MAJOR:-3}"
readonly GPU_PYTHON_MIN_MINOR="${GPU_PYTHON_MIN_MINOR:-10}"
readonly GPU_PYTHON_MIN_VERSION="${GPU_PYTHON_MIN_MAJOR}.${GPU_PYTHON_MIN_MINOR}"

gpu_python_version() {
    "$1" - <<'PY' 2>/dev/null
import platform
print(platform.python_version())
PY
}

gpu_python_meets_minimum() {
    "$1" - "$GPU_PYTHON_MIN_MAJOR" "$GPU_PYTHON_MIN_MINOR" <<'PY' >/dev/null 2>&1
import sys

major = int(sys.argv[1])
minor = int(sys.argv[2])
raise SystemExit(0 if sys.version_info >= (major, minor) else 1)
PY
}

select_gpu_python_bin() {
    local venv_dir="${1:-}"
    local requested="${PYTHON_BIN:-}"
    local candidate=""
    local version=""
    local -a candidates=()

    if [ -n "$requested" ]; then
        candidates+=("$requested")
    else
        if [ -n "$venv_dir" ] && [ -x "$venv_dir/bin/python" ]; then
            candidates+=("$venv_dir/bin/python")
        fi
        candidates+=(python3 python3.14 python3.13 python3.12 python3.11 python3.10)
    fi

    for candidate in "${candidates[@]}"; do
        if command -v "$candidate" >/dev/null 2>&1 && gpu_python_meets_minimum "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    if [ -n "$requested" ]; then
        if command -v "$requested" >/dev/null 2>&1; then
            version="$(gpu_python_version "$requested" || true)"
            if [ -n "$version" ]; then
                echo "Error: PYTHON_BIN=$requested resolved to Python $version; GPU services require Python $GPU_PYTHON_MIN_VERSION or newer." >&2
            else
                echo "Error: PYTHON_BIN=$requested is not a usable Python executable." >&2
            fi
        else
            echo "Error: Python executable not found: $requested" >&2
        fi
    else
        echo "Error: GPU services require Python $GPU_PYTHON_MIN_VERSION or newer." >&2
        echo "Install Python $GPU_PYTHON_MIN_VERSION+ or rerun with PYTHON_BIN=/path/to/python3.11." >&2
    fi
    exit 1
}

ensure_gpu_venv_python() {
    local venv_dir="$1"
    local python_bin="$2"
    local venv_python="$venv_dir/bin/python"
    local venv_version=""
    local selected_version=""

    if [ ! -x "$venv_python" ]; then
        return 0
    fi

    if gpu_python_meets_minimum "$venv_python"; then
        return 0
    fi

    venv_version="$(gpu_python_version "$venv_python" || printf 'unknown')"
    selected_version="$(gpu_python_version "$python_bin" || printf 'unknown')"
    echo "Existing virtualenv at $venv_dir uses Python $venv_version; recreating it with $python_bin (Python $selected_version)." >&2
    rm -rf "$venv_dir"
}
