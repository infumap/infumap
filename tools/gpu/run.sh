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
readonly RESTART_DELAY_SECS="${GPU_RESTART_DELAY_SECS:-5}"
export GPU_MODELS_DIR="${GPU_MODELS_DIR:-$ROOT_DIR/models}"
readonly SERVICES=(
    "gateway"
    "image_tagging"
    "text_embedding"
    "text_extraction"
)

supervisor_pids=()
shutdown_requested=0
LAUNCHED_CHILD_PID=""

fail() {
    echo "Error: $1" >&2
    exit 1
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

service_run_script() {
    local service_name="$1"
    printf '%s/%s/run.sh\n' "$ROOT_DIR" "$service_name"
}

log_service() {
    local service_name="$1"
    local message="$2"
    printf '[gpu/%s] %s\n' "$service_name" "$message"
}

supervise_service() {
    local service_name="$1"
    local run_script
    run_script="$(service_run_script "$service_name")"
    local child_pid=""
    local shutdown_local=0
    local restart_count=0

    stop_supervisor() {
        shutdown_local=1
        if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
            terminate_child "$child_pid"
            wait_for_child_shutdown "$child_pid"
        fi
    }

    trap stop_supervisor INT TERM

    while true; do
        log_service "$service_name" "starting ${run_script#$ROOT_DIR/}"
        launch_child "$run_script"
        child_pid="$LAUNCHED_CHILD_PID"

        set +e
        wait "$child_pid"
        exit_code=$?
        set -e

        child_pid=""

        if [ "$shutdown_local" -eq 1 ]; then
            exit 0
        fi

        restart_count="$((restart_count + 1))"
        if [ "$exit_code" -eq 0 ]; then
            log_service "$service_name" "exited cleanly; restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})."
        elif [ "$exit_code" -eq 139 ]; then
            log_service "$service_name" "crashed with SIGSEGV (exit 139); restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})."
        elif [ "$exit_code" -gt 128 ]; then
            log_service "$service_name" "exited due to signal $((exit_code - 128)) (exit ${exit_code}); restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})."
        else
            log_service "$service_name" "exited with status ${exit_code}; restarting in ${RESTART_DELAY_SECS}s (restart #${restart_count})."
        fi

        sleep "$RESTART_DELAY_SECS"
    done
}

cleanup() {
    if [ "$shutdown_requested" -eq 1 ]; then
        return
    fi
    shutdown_requested=1

    local pid
    for pid in "${supervisor_pids[@]:-}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    for pid in "${supervisor_pids[@]:-}"; do
        wait "$pid" 2>/dev/null || true
    done
}

trap cleanup EXIT INT TERM

echo "Starting Infumap GPU services"
echo "GPU_RESTART_DELAY_SECS=${RESTART_DELAY_SECS}"
echo "GPU_MODELS_DIR=${GPU_MODELS_DIR}"
echo "Services: ${SERVICES[*]}"
if command -v nvidia-smi >/dev/null 2>&1; then
    echo "Detected GPUs via nvidia-smi:"
    nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader || true
else
    echo "nvidia-smi: not found"
fi

for service_name in "${SERVICES[@]}"; do
    run_script="$(service_run_script "$service_name")"
    [ -x "$run_script" ] || fail "Expected executable service launcher at $run_script"
    supervise_service "$service_name" &
    supervisor_pids+=("$!")
done

wait_status=0
set +e
wait "${supervisor_pids[@]}"
wait_status=$?
set -e

exit "$wait_status"
