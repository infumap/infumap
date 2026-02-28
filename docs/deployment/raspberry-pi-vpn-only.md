## Raspberry Pi / VPN-Only HTTPS (Caddy Internal CA)

In this setup, Infumap is reachable only from WireGuard peers. It is not exposed to the public internet.

This is the more secure deployment profile because the Infumap and optional Grafana endpoints are not reachable from the public internet at all. The tradeoff is that every client must first join the WireGuard network.

Complete the shared baseline guide first:

- [Raspberry Pi / VPN common setup](raspberry-pi.md)

### Domain and DNS model

Choose a stable hostname for Infumap under a domain you control (for example, `infumap.yourdomain.tld`).

If you also want VPN-only Grafana, choose a second hostname (for example, `grafana.yourdomain.tld`).

#### Local DNS on VPS over WireGuard

Run `dnsmasq` on the VPS WireGuard address (`10.0.0.1`) and publish private DNS records that point to the Raspberry Pi WireGuard IP (`10.0.0.2`).

On the VPS (`10.0.0.1`):

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
    # Optional Grafana hostname:
    #address=/grafana.yourdomain.tld/10.0.0.2

`1.1.1.1` and `1.0.0.1` are Cloudflare public DNS resolvers. They are used here as upstream resolvers for all non-local
lookups because they are widely available, fast, and provide simple redundancy. You can replace them with your preferred
upstream resolvers (for example, Quad9 or Google Public DNS). `local-ttl=300` tells clients to cache local DNS mappings
for about five minutes, reducing repeated lookups from iPhone and laptop clients.

Start and verify on the VPS:

    sudo systemctl enable dnsmasq
    sudo systemctl restart dnsmasq
    sudo systemctl status dnsmasq
    nslookup infumap.yourdomain.tld 10.0.0.1

If you enabled Grafana DNS:

    nslookup grafana.yourdomain.tld 10.0.0.1

If UFW is enabled on the VPS, allow DNS only from the WireGuard subnet:

    sudo ufw allow from 10.0.0.0/24 to 10.0.0.1 port 53 proto udp
    sudo ufw allow from 10.0.0.0/24 to 10.0.0.1 port 53 proto tcp

Configure name resolution for iPhone and macOS clients:

- iPhone: Open the WireGuard app, edit the tunnel, and set `DNS Servers` to `10.0.0.1` (this is the only practical option on iPhone).
- macOS: Prefer `/etc/hosts` entries for VPN-only hostnames instead of tunnel DNS. You can also set `DNS = 10.0.0.1` in the WireGuard config, but every lookup adds an extra hop to the VPS DNS resolver and introduces a dependency on `10.0.0.1` being available.

On macOS:

    sudoedit /etc/hosts

Add:

    10.0.0.2 infumap.yourdomain.tld
    # Optional Grafana hostname:
    #10.0.0.2 grafana.yourdomain.tld


### Run HTTPS with Caddy Internal CA

Install Caddy on the Pi:

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
        tls internal
        reverse_proxy 127.0.0.1:8000
    }

    # Optional Grafana hostname:
    #grafana.yourdomain.tld {
    #    tls internal
    #    reverse_proxy 127.0.0.1:3000
    #}

Reload and enable Caddy:

    sudo systemctl daemon-reload
    sudo systemctl enable caddy
    sudo systemctl restart caddy
    sudo systemctl status caddy

### Trust Caddy's Root Certificate on Clients

Caddy's internal CA root certificate is stored on the Raspberry Pi at:

    /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

Copy that `root.crt` file to each trusted client.

On macOS:

- Open Keychain Access and import `root.crt` into the `System` or `login` keychain.
- Open the certificate, expand `Trust`, and set `When using this certificate` to `Always Trust`.
- Quit and reopen browsers.

On iPhone:

- AirDrop the certificate to the phone (rename it to `.crt` if needed).
- Install it via `Settings -> General -> VPN & Device Management`.
- Enable full trust via `Settings -> General -> About -> Certificate Trust Settings`.

Any hostname issued by this Caddy internal CA (for example, `infumap.yourdomain.tld` and `grafana.yourdomain.tld`) will be trusted once this root is installed.

### Keep Access VPN-Only

On the Raspberry Pi, keep inbound `443/tcp` restricted to the WireGuard subnet, as configured in the common guide:

    sudo ufw status verbose

On the VPS, do not configure DNAT forwarding for `80/443` to the Raspberry Pi.

If you previously configured the public internet profile, remove the `80/443` DNAT and MASQUERADE rules from `/etc/ufw/before.rules`, run `sudo ufw reload`, and remove any VPS UFW routed allow rules that forward public `80/443` traffic to `10.0.0.2`.

### Verification

From a VPN-connected admin client:

    ping infumap.yourdomain.tld
    curl -I https://infumap.yourdomain.tld
    curl -I https://grafana.yourdomain.tld   # if enabled
    ssh infumap@10.0.0.2

If HTTPS fails, check the Caddy logs:

    sudo journalctl -u caddy -n 200 --no-pager

### Maintenance

- `tls internal` certificates are issued and renewed automatically by Caddy; no cron job is required.
- Preserve Caddy PKI state (`/var/lib/caddy/.local/share/caddy/pki`) in backups so client trust remains stable across rebuilds.
- If Caddy's root CA changes, redistribute the new `root.crt` to all client trust stores.
- After hostname or Caddyfile changes, reload Caddy and verify with `curl -I https://infumap.yourdomain.tld`.
