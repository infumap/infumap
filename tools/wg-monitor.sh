#!/bin/bash

set -euo pipefail
PATH="/usr/sbin:/usr/bin:/sbin:/bin"

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


readonly PING_BIN="$(command -v ping)"
readonly SYSTEMCTL_BIN="$(command -v systemctl)"
readonly DATE_BIN="$(command -v date)"
readonly TEE_BIN="$(command -v tee)"

ping_server() {
    local server="$1"
    "$PING_BIN" -c 1 -W 5 "$server" > /dev/null 2>&1
}

restart_wireguard_service() {
    "$SYSTEMCTL_BIN" restart wg-quick@wg0
}

log() {
    local target_log_file="$1"
    local message="$2"
    echo "$("$DATE_BIN" '+%Y-%m-%d %H:%M:%S') - ${message}" | "$TEE_BIN" -a "$target_log_file" > /dev/null
}

if [ "$#" -ne 2 ]; then
    echo "A tool for monitoring a WireGuard network, and restarting the WireGuard service if a problem is detected."
    echo ""
    echo "Usage: $0 <server> <log-file>"
    exit 1
fi

readonly server="$1"
readonly log_file="$2"

log "$log_file" "Command executed: $0 $*"

while true; do
    sleep 60
    # I encountered a high CPU issue that was bad enough to prevent ssh access. I used the commented out command here to help debug that.
    # top -b -c -n 1 -d 1 -w 160 | head -n 18 > /home/pi/top-log/top-$(date "+%Y-%m-%d_%H-%M-%S")
    if ! ping_server "$server"; then
        log "$log_file" "Ping to $server failed. Restarting WireGuard service."
        restart_wireguard_service
        sleep 240
    fi
done
