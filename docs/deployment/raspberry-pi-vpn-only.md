## Raspberry Pi / VPN-Only HTTPS (local CA)

This guide keeps Infumap reachable only to WireGuard peers. There is no public internet exposure on ports `80/443`.

Complete the shared baseline guide first:

- [Raspberry Pi / VPN common setup](raspberry-pi.md)

### Domain and DNS model

Pick a stable hostname for Infumap under a domain you own/control (for example `infumap.yourdomain.tld`).
What matters in this profile is:

- Clients can resolve that hostname over WireGuard.
- The hostname matches the certificate `subjectAltName` you issue below.

Because this deployment is VPN-only, clients must resolve that hostname to the Raspberry Pi WireGuard IP (for example `10.0.0.2`).
This guide uses a DNS resolver on the VPS WireGuard IP (`10.0.0.1`), and clients query it through WireGuard.

#### Local DNS on VPS over WireGuard

Run `dnsmasq` on the VPS WireGuard address (`10.0.0.1`) and publish a private record for Infumap.
If your WireGuard interface is not `wg0`, substitute your interface name in the config below.

On VPS (`10.0.0.1`):

    sudo apt update
    sudo apt install -y dnsmasq

Create `/etc/dnsmasq.d/infumap-vpn.conf`:

    interface=wg0
    bind-interfaces
    listen-address=10.0.0.1
    domain-needed
    bogus-priv
    no-resolv
    local-ttl=300
    server=1.1.1.1
    server=1.0.0.1
    address=/infumap.yourdomain.tld/10.0.0.2

`1.1.1.1` and `1.0.0.1` are Cloudflare public DNS resolvers. They are used here as upstream DNS for all non-`infumap.yourdomain.tld`
lookups because they are widely available, fast, and give simple redundancy. You can replace them with your preferred upstream resolvers
(for example Quad9 or Google Public DNS). `local-ttl=300` tells clients to cache the local `infumap.yourdomain.tld` mapping for about 5
minutes, reducing repeat DNS lookups from both iPhone and laptop.

Start and verify on the VPS:

    sudo systemctl enable dnsmasq
    sudo systemctl restart dnsmasq
    sudo systemctl status dnsmasq
    nslookup infumap.yourdomain.tld 10.0.0.1

If UFW is enabled on the VPS, allow DNS only from the WireGuard subnet:

    sudo ufw allow from 10.0.0.0/24 to 10.0.0.1 port 53 proto udp
    sudo ufw allow from 10.0.0.0/24 to 10.0.0.1 port 53 proto tcp

Configure iPhone and laptop to use VPS DNS over WireGuard:

- iPhone: open the WireGuard app, edit the tunnel, and set `DNS Servers` to `10.0.0.1`.
- macOS laptop: edit the WireGuard tunnel and set `DNS Servers` to `10.0.0.1` (or add `DNS = 10.0.0.1` under `[Interface]` in the tunnel config).
- Ensure each client tunnel `AllowedIPs` includes your WireGuard subnet (for example `10.0.0.0/24`).
- Reconnect the tunnel, then browse to `https://infumap.yourdomain.tld`.

If `10.0.0.1` is down while the tunnel is up, DNS lookups through the tunnel will fail.
For temporary general internet access, disable the WireGuard tunnel (or temporarily switch tunnel DNS to a working resolver) until VPS DNS is restored.

### Run HTTPS with your own CA on the Raspberry Pi

Because `infumap` is only reachable through WireGuard, you can run your own CA on the Raspberry Pi and issue certificates locally. This avoids enabling domain registrar API access (and storing associated high-privilege credentials on your systems), while still giving trusted clients valid HTTPS for `infumap.yourdomain.tld`.

#### Generate a root CA and leaf certificate

In the commands below, replace `infumap.yourdomain.tld` with your chosen hostname.

On the Pi:

    sudo mkdir -p /etc/infumap/ca /etc/infumap/tls
    sudo chown root:root /etc/infumap /etc/infumap/ca
    sudo chown root:caddy /etc/infumap/tls
    sudo chmod 700 /etc/infumap/ca
    sudo chmod 750 /etc/infumap/tls

Create the root CA private key with a passphrase. Do not grant Caddy access to this key:

    sudo openssl genpkey -algorithm RSA -out /etc/infumap/ca/root.key.pem -aes256 -pkeyopt rsa_keygen_bits:4096

Generate the self-signed root certificate:

    sudo openssl req -x509 -new -key /etc/infumap/ca/root.key.pem \
      -sha256 -days 3650 -out /etc/infumap/ca/root.cert.pem \
      -subj "/CN=Infumap VPN CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash"

Create an unencrypted server key for Caddy and a CSR:

    sudo openssl genpkey -algorithm RSA -out /etc/infumap/tls/infumap.key.pem \
      -pkeyopt rsa_keygen_bits:2048

    sudo openssl req -new -sha256 -key /etc/infumap/tls/infumap.key.pem \
      -out /etc/infumap/tls/infumap.csr \
      -subj "/CN=infumap.yourdomain.tld"

Write leaf certificate extensions including SAN:

    cat <<'EOF' | sudo tee /etc/infumap/tls/infumap.ext >/dev/null
    basicConstraints=critical,CA:FALSE
    keyUsage=critical,digitalSignature,keyEncipherment
    extendedKeyUsage=serverAuth
    subjectAltName=DNS:infumap.yourdomain.tld
    authorityKeyIdentifier=keyid,issuer
    EOF

Issue the leaf certificate signed by your root:

    sudo openssl x509 -req -in /etc/infumap/tls/infumap.csr \
      -CA /etc/infumap/ca/root.cert.pem -CAkey /etc/infumap/ca/root.key.pem \
      -CAcreateserial -sha256 -days 397 \
      -extfile /etc/infumap/tls/infumap.ext \
      -out /etc/infumap/tls/infumap.cert.pem

Set permissions so Caddy can read only the leaf key, never the root key:

    sudo chown root:root /etc/infumap/ca/root.key.pem /etc/infumap/ca/root.cert.pem
    sudo chmod 600 /etc/infumap/ca/root.key.pem
    sudo chmod 644 /etc/infumap/ca/root.cert.pem
    sudo chown root:caddy /etc/infumap/tls/infumap.key.pem /etc/infumap/tls/infumap.cert.pem /etc/infumap/tls/infumap.csr /etc/infumap/tls/infumap.ext
    sudo chmod 640 /etc/infumap/tls/infumap.key.pem
    sudo chmod 644 /etc/infumap/tls/infumap.cert.pem /etc/infumap/tls/infumap.csr /etc/infumap/tls/infumap.ext

Keep the root key off any laptop/phone: only the Pi should hold it.

#### Configure Caddy for the local cert

Install Caddy normally from Debian:

    sudo apt update
    sudo apt install -y caddy

Create or update `/etc/caddy/Caddyfile`:

    {
        log {
            output file /var/log/caddy/access.log {
                mode 0600
                roll_size 10MiB
                roll_keep 5
                roll_keep_for 168h
            }
            format json
        }
    }

    infumap.yourdomain.tld {
        tls /etc/infumap/tls/infumap.cert.pem /etc/infumap/tls/infumap.key.pem
        reverse_proxy 127.0.0.1:8000
    }

Reload and enable Caddy:

    sudo systemctl daemon-reload
    sudo systemctl enable caddy
    sudo systemctl restart caddy
    sudo systemctl status caddy

#### Distribute the root certificate to clients

Copy `/etc/infumap/ca/root.cert.pem` to each trusted machine and device. On macOS:

  - Double-click the file to open Keychain Access.
  - Import it into the `System` or `login` keychain, then open the certificate, expand `Trust`, and set `When using this certificate` to `Always Trust`.
  - Quit/reopen browsers so they pick up the trusted root.

On iPhone:

  - AirDrop the cert to the phone (use `.crt` if your client tools prefer that extension).
  - Open the cert from Files and install it via `Settings -> General -> VPN & Device Management`.
  - In `Settings -> General -> About -> Certificate Trust Settings`, enable full trust for that root certificate.

You must perform these steps for each device that needs to hit `infumap.yourdomain.tld`. Keep the root cert public but never export the private key.

### Keep access VPN-only

On Raspberry Pi, keep inbound `443/tcp` restricted to the WireGuard subnet (as configured in the common guide):

    sudo ufw status verbose

On VPS, do not configure DNAT forwarding for `80/443` to the Raspberry Pi.

If you previously configured public forwarding rules, remove them and restart `nftables`.

### Verification

From a VPN-connected admin client:

    ping infumap.yourdomain.tld
    curl -I https://infumap.yourdomain.tld
    ssh pi@10.0.0.2

If HTTPS fails, check Caddy logs:

    sudo journalctl -u caddy -n 200 --no-pager

### Automate leaf renewal with cron

The commands below automate leaf renewal on the Pi without any client changes (as long as the same root CA is used).

Store the root CA passphrase in a root-only file for non-interactive signing:

    sudo sh -c 'umask 077; printf "%s\n" "YOUR_ROOT_CA_PASSPHRASE" > /etc/infumap/ca/root.passphrase'
    sudo chown root:root /etc/infumap/ca/root.passphrase
    sudo chmod 600 /etc/infumap/ca/root.passphrase

Create `/usr/local/sbin/infumap-renew-leaf.sh`:

    sudoedit /usr/local/sbin/infumap-renew-leaf.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

HOSTNAME_FQDN="${1:-infumap.yourdomain.tld}"
CA_DIR="/etc/infumap/ca"
TLS_DIR="/etc/infumap/tls"
PASS_FILE="$CA_DIR/root.passphrase"
SERIAL_FILE="$CA_DIR/root.cert.srl"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

test -r "$PASS_FILE"
test -r "$CA_DIR/root.cert.pem"
test -r "$CA_DIR/root.key.pem"
test -r "$TLS_DIR/infumap.key.pem"

openssl req -new -sha256 \
  -key "$TLS_DIR/infumap.key.pem" \
  -out "$TMP_DIR/infumap.csr" \
  -subj "/CN=$HOSTNAME_FQDN"

cat > "$TMP_DIR/infumap.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$HOSTNAME_FQDN
authorityKeyIdentifier=keyid,issuer
EOF

if [ -f "$SERIAL_FILE" ]; then
  SERIAL_ARGS=(-CAserial "$SERIAL_FILE")
else
  SERIAL_ARGS=(-CAcreateserial)
fi

openssl x509 -req \
  -in "$TMP_DIR/infumap.csr" \
  -CA "$CA_DIR/root.cert.pem" \
  -CAkey "$CA_DIR/root.key.pem" \
  -passin "file:$PASS_FILE" \
  "${SERIAL_ARGS[@]}" \
  -sha256 -days 397 \
  -extfile "$TMP_DIR/infumap.ext" \
  -out "$TMP_DIR/infumap.cert.pem"

install -o root -g caddy -m 0644 "$TMP_DIR/infumap.cert.pem" "$TLS_DIR/infumap.cert.pem"
systemctl reload caddy
```

Set script permissions and run once manually:

    sudo chown root:root /usr/local/sbin/infumap-renew-leaf.sh
    sudo chmod 0750 /usr/local/sbin/infumap-renew-leaf.sh
    sudo /usr/local/sbin/infumap-renew-leaf.sh infumap.yourdomain.tld

Schedule monthly renewal as root:

    sudo crontab -e

Add:

    0 3 1 * * /usr/local/sbin/infumap-renew-leaf.sh infumap.yourdomain.tld >> /var/log/infumap-cert-renew.log 2>&1

Verify the updated certificate:

    openssl x509 -in /etc/infumap/tls/infumap.cert.pem -noout -dates -subject

### Maintenance

- Automate leaf renewal on the Pi (see section above) and keep the renewal job running.
- Leaf renewals are transparent to clients as long as they are still signed by the same root CA; laptop/iPhone do not need certificate updates for leaf rotations.
- If you ever regenerate the root CA (for example after suspected compromise), copy the new `/etc/infumap/ca/root.cert.pem` to each client and remove the old root from their trust stores.
- Whenever you change the cert/key pair, verify reachability with `curl -I https://infumap.yourdomain.tld`.
