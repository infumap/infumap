# Common Python runtime helpers for GPU service launchers.

readonly GPU_PYTHON_MIN_MAJOR="${GPU_PYTHON_MIN_MAJOR:-3}"
readonly GPU_PYTHON_MIN_MINOR="${GPU_PYTHON_MIN_MINOR:-10}"
readonly GPU_PYTHON_MIN_VERSION="${GPU_PYTHON_MIN_MAJOR}.${GPU_PYTHON_MIN_MINOR}"
readonly GPU_PYTHON_MAX_MAJOR="${GPU_PYTHON_MAX_MAJOR:-3}"
readonly GPU_PYTHON_MAX_MINOR="${GPU_PYTHON_MAX_MINOR:-13}"
readonly GPU_PYTHON_MAX_VERSION="${GPU_PYTHON_MAX_MAJOR}.${GPU_PYTHON_MAX_MINOR}"
readonly GPU_PYTHON_SUPPORTED_VERSION_RANGE="${GPU_PYTHON_MIN_VERSION} through ${GPU_PYTHON_MAX_VERSION}"

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

gpu_python_supported() {
    "$1" - "$GPU_PYTHON_MIN_MAJOR" "$GPU_PYTHON_MIN_MINOR" "$GPU_PYTHON_MAX_MAJOR" "$GPU_PYTHON_MAX_MINOR" <<'PY' >/dev/null 2>&1
import sys

min_major = int(sys.argv[1])
min_minor = int(sys.argv[2])
max_major = int(sys.argv[3])
max_minor = int(sys.argv[4])
raise SystemExit(0 if (min_major, min_minor) <= sys.version_info[:2] <= (max_major, max_minor) else 1)
PY
}

add_gpu_python_candidate() {
    local candidate="$1"
    local existing=""

    [ -n "$candidate" ] || return 0

    for existing in "${candidates[@]}"; do
        if [ "$existing" = "$candidate" ]; then
            return 0
        fi
    done

    candidates+=("$candidate")
}

add_homebrew_gpu_python_candidates() {
    local brew_prefix=""
    local formula_prefix=""
    local minor=""

    if command -v brew >/dev/null 2>&1; then
        brew_prefix="$(brew --prefix 2>/dev/null || true)"
        if [ -n "$brew_prefix" ]; then
            for minor in 13 12 11 10; do
                add_gpu_python_candidate "$brew_prefix/bin/python3.$minor"
            done
        fi

        for minor in 13 12 11 10; do
            formula_prefix="$(brew --prefix "python@3.$minor" 2>/dev/null || true)"
            if [ -n "$formula_prefix" ]; then
                add_gpu_python_candidate "$formula_prefix/bin/python3.$minor"
            fi
        done
    fi

    for minor in 13 12 11 10; do
        add_gpu_python_candidate "/opt/homebrew/bin/python3.$minor"
        add_gpu_python_candidate "/opt/homebrew/opt/python@3.$minor/bin/python3.$minor"
        add_gpu_python_candidate "/usr/local/bin/python3.$minor"
        add_gpu_python_candidate "/usr/local/opt/python@3.$minor/bin/python3.$minor"
        add_gpu_python_candidate "/Library/Frameworks/Python.framework/Versions/3.$minor/bin/python3.$minor"
    done
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
            add_gpu_python_candidate "$venv_dir/bin/python"
        fi
        add_gpu_python_candidate python3.13
        add_gpu_python_candidate python3.12
        add_gpu_python_candidate python3.11
        add_gpu_python_candidate python3.10
        add_homebrew_gpu_python_candidates
        add_gpu_python_candidate python3
    fi

    for candidate in "${candidates[@]}"; do
        if command -v "$candidate" >/dev/null 2>&1 && gpu_python_supported "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    if [ -n "$requested" ]; then
        if command -v "$requested" >/dev/null 2>&1; then
            version="$(gpu_python_version "$requested" || true)"
            if [ -n "$version" ]; then
                echo "Error: PYTHON_BIN=$requested resolved to Python $version; GPU services require Python $GPU_PYTHON_SUPPORTED_VERSION_RANGE." >&2
            else
                echo "Error: PYTHON_BIN=$requested is not a usable Python executable." >&2
            fi
        else
            echo "Error: Python executable not found: $requested" >&2
        fi
    else
        echo "Error: GPU services require Python $GPU_PYTHON_SUPPORTED_VERSION_RANGE." >&2
        echo "Install Python $GPU_PYTHON_MAX_VERSION (for example, brew install python@3.13) or rerun with PYTHON_BIN=/path/to/python3.13." >&2
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

    if gpu_python_supported "$venv_python"; then
        return 0
    fi

    venv_version="$(gpu_python_version "$venv_python" || printf 'unknown')"
    selected_version="$(gpu_python_version "$python_bin" || printf 'unknown')"
    echo "Existing virtualenv at $venv_dir uses Python $venv_version; GPU services require Python $GPU_PYTHON_SUPPORTED_VERSION_RANGE, so recreating it with $python_bin (Python $selected_version)." >&2
    rm -rf "$venv_dir"
}
