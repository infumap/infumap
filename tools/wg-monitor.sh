#!/bin/bash

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


ping_server() {
    local server="$1"
    ping -c 1 "$server" > /dev/null 2>&1
    return $?
}

restart_wireguard_service() {
    sudo systemctl restart wg-quick@wg0
}

if [ "$#" -ne 2 ]; then
    echo "A tool for monitoring a WireGuard network, and restarting the WireGuard service if a problem is detected."
    echo ""
    echo "Usage: $0 <server> <log-file>"
    exit 1
fi

server="$1"
log_file="$2"

echo "$(date '+%Y-%m-%d %H:%M:%S') - Command executed: $0 $*" >> "$log_file"

while true; do
    sleep 60
    if ! ping_server "$server"; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - Ping to $server failed. Restarting WireGuard service." >> "$log_file"
        restart_wireguard_service
        sleep 240
    fi
done
