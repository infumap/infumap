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


readonly WG_CONFIG_PATH="/etc/wireguard/wg0.conf"

readonly CAT_BIN="$(command -v cat)"
readonly GREP_BIN="$(command -v grep)"
readonly HEAD_BIN="$(command -v head)"
readonly ID_BIN="$(command -v id)"
readonly MKTEMP_BIN="$(command -v mktemp)"
readonly RM_BIN="$(command -v rm)"
readonly SYSTEMCTL_BIN="$(command -v systemctl)"
readonly WC_BIN="$(command -v wc)"

usage() {
    echo "Add a WireGuard peer to /etc/wireguard/wg0.conf on the VPS and restart wg-quick@wg0."
    echo ""
    echo "Usage: $0 <peer-name> <peer-ip> <peer-public-key>"
    echo ""
    echo "Example:"
    echo "  sudo $0 iphone 10.0.0.11 AbCdEfGh..."
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

if [ "$#" -ne 3 ]; then
    usage
    exit 1
fi

if [ "$("$ID_BIN" -u)" -ne 0 ]; then
    fail "This script must be run as root."
fi

readonly peer_name="$1"
readonly peer_ip="$2"
readonly peer_public_key="$3"

if [[ ! "$peer_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    fail "Peer name must contain only letters, numbers, dots, underscores, and hyphens."
fi

validate_ipv4 "$peer_ip" || fail "Peer IP must be a valid IPv4 address."

if [ -z "$peer_public_key" ] || [[ "$peer_public_key" =~ [[:space:]] ]]; then
    fail "Peer public key must be a single line with no spaces."
fi

[ -f "$WG_CONFIG_PATH" ] || fail "WireGuard config '$WG_CONFIG_PATH' does not exist."

if "$GREP_BIN" -Fq "# infumap-peer: ${peer_name}" "$WG_CONFIG_PATH"; then
    fail "A peer named '${peer_name}' already exists in '$WG_CONFIG_PATH'."
fi

if "$GREP_BIN" -Fq "AllowedIPs = ${peer_ip}/32" "$WG_CONFIG_PATH"; then
    fail "A peer using '${peer_ip}/32' already exists in '$WG_CONFIG_PATH'."
fi

readonly original_line_count="$("$WC_BIN" -l < "$WG_CONFIG_PATH")"

{
    echo ""
    echo "# infumap-peer: ${peer_name}"
    echo "[Peer]"
    echo "PublicKey = ${peer_public_key}"
    echo "AllowedIPs = ${peer_ip}/32"
} >> "$WG_CONFIG_PATH"

if ! "$SYSTEMCTL_BIN" restart wg-quick@wg0; then
    temp_file="$("$MKTEMP_BIN")"
    "$HEAD_BIN" -n "$original_line_count" "$WG_CONFIG_PATH" > "$temp_file"
    "$CAT_BIN" "$temp_file" > "$WG_CONFIG_PATH"
    "$RM_BIN" -f "$temp_file"
    "$SYSTEMCTL_BIN" restart wg-quick@wg0 || true
    fail "Restarting wg-quick@wg0 failed. Reverted the appended peer block."
fi

echo "Added peer '${peer_name}' with ${peer_ip}/32 to '$WG_CONFIG_PATH'."
echo "Verify the handshake after you enable the tunnel on iPhone:"
echo "  sudo wg show wg0"
