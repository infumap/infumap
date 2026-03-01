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


readonly QR_ENCODE_BIN="$(command -v qrencode)"
readonly WG_BIN="$(command -v wg)"

usage() {
    echo "Generate a WireGuard iPhone client config and QR code on a trusted host without storing the private key on the VPS."
    echo ""
    echo "Usage: $0 <peer-name> <peer-ip> <endpoint-host-or-ip> [listen-port]"
    echo ""
    echo "Example:"
    echo "  $0 iphone 10.0.0.11 203.0.113.10"
}

fail() {
    echo "Error: $1" >&2
    exit 1
}

validate_ipv4() {
    local ip="$1"

    if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        return 1
    fi

    local octet
    IFS='.' read -r -a octets <<< "$ip"
    for octet in "${octets[@]}"; do
        if [ "$octet" -lt 0 ] || [ "$octet" -gt 255 ]; then
            return 1
        fi
    done
}

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    usage
    exit 1
fi

readonly peer_name="$1"
readonly peer_ip="$2"
readonly endpoint_host="$3"
readonly listen_port="${4:-43821}"

if [[ ! "$peer_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    fail "Peer name must contain only letters, numbers, dots, underscores, and hyphens."
fi

validate_ipv4 "$peer_ip" || fail "Peer IP must be a valid IPv4 address."

if [[ "$endpoint_host" =~ [[:space:]] ]]; then
    fail "Endpoint host or IP must not contain spaces."
fi

if [[ ! "$listen_port" =~ ^[0-9]+$ ]] || [ "$listen_port" -lt 1 ] || [ "$listen_port" -gt 65535 ]; then
    fail "Listen port must be an integer in the range 1-65535."
fi

[ -x "$WG_BIN" ] || fail "wg is not installed."
[ -x "$QR_ENCODE_BIN" ] || fail "qrencode is not installed."

echo "Paste the VPS server public key, then press Enter:"
read -r server_public_key

if [ -z "$server_public_key" ]; then
    fail "Server public key must not be empty."
fi

if [[ "$server_public_key" =~ [[:space:]] ]]; then
    fail "Server public key must be a single line with no spaces."
fi

readonly client_private_key="$("$WG_BIN" genkey)"
readonly client_public_key="$(printf '%s' "$client_private_key" | "$WG_BIN" pubkey)"

client_config="$(
    cat <<EOF
[Interface]
PrivateKey = ${client_private_key}
Address = ${peer_ip}/24

[Peer]
PublicKey = ${server_public_key}
AllowedIPs = 10.0.0.0/24
Endpoint = ${endpoint_host}:${listen_port}
PersistentKeepalive = 25
EOF
)"

echo ""
echo "Run this on infumap-vps to add the peer:"
echo "  sudo /usr/local/bin/wg-peer-add.sh ${peer_name} ${peer_ip} ${client_public_key}"
echo ""
echo "Client public key:"
echo "  ${client_public_key}"
echo ""
echo "Scan this QR code from the WireGuard iPhone app:"
printf '%s\n' "$client_config" | "$QR_ENCODE_BIN" -t ansiutf8
echo ""
echo "After importing the tunnel, if you later follow the VPN-only HTTPS profile, edit the iPhone tunnel and set DNS Servers to 10.0.0.1."
