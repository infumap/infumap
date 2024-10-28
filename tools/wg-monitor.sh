#!/bin/bash

ping_server() {
    local server="$1"
    ping -c 1 "$server" > /dev/null 2>&1
    return $?
}

restart_wireguard_service() {
    sudo systemctl restart wg-quick@wg0
}

log_public_ip() {
    local log_file="$1"
    local ip
    ip=$(curl -s -4 https://ifconfig.me)
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Public IP: $ip" >> "$log_file"
}

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <server> <log_file>"
    exit 1
fi

server="$1"
log_file="$2"

echo "Executed: $0 $*" >> "$log_file"

while true; do
    log_public_ip "$log_file"

    if ! ping_server "$server"; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - Ping to $server failed. Restarting WireGuard service." >> "$log_file"
        restart_wireguard_service
    else
        echo "Ping to $server succeeded."
    fi

    sleep 60
done
