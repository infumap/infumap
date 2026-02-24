## Raspberry Pi / VPN-Only HTTPS (Namecheap DNS Challenge)

This profile keeps Infumap reachable only to WireGuard peers. There is no public internet exposure on ports `80/443`.

Complete the shared baseline guide first:

- [Raspberry Pi / VPN common setup](raspberry-pi.md)

### Domain and DNS model

Pick a domain name for Infumap, for example `infumap.example.com`.

Because this deployment is VPN-only, clients must resolve that name to the Raspberry Pi WireGuard IP (for example
`10.0.0.2`). Use one of these approaches:

- Add a host override on each admin client.
- Use an internal DNS server reachable over WireGuard.

For a quick local override on macOS:

    echo "10.0.0.2 infumap.example.com" | sudo tee -a /etc/hosts

### Enable Namecheap API access

In Namecheap, go to `Profile -> Tools -> API Access` and enable API access.

Whitelist the public IPv4 address that Namecheap will see for API calls:

- Direct mode (no proxy): whitelist your home network egress IP from the Raspberry Pi:

    curl -4 ifconfig.me

- VPS-proxy mode (recommended when home IP is dynamic): whitelist your VPS public IPv4.

If you use direct mode and your home public IP changes, update both the Namecheap whitelist and the Caddy
`NAMECHEAP_CLIENT_IP` value.

### (Optional, recommended for dynamic home IP) Route only Caddy egress via VPS

This keeps normal Raspberry Pi internet traffic direct. Only outbound HTTP(S) from the `caddy` service is proxied
through the VPS.

On VPS, install and configure a small HTTP CONNECT proxy bound to WireGuard:

    sudo apt update
    sudo apt install -y tinyproxy
    sudoedit /etc/tinyproxy/tinyproxy.conf

Set at least:

    Port 3128
    Listen 10.0.0.1
    Allow 10.0.0.2

If UFW is active on the VPS, allow proxy access only from the Raspberry Pi WireGuard IP:

    sudo ufw allow from 10.0.0.2 to any port 3128 proto tcp

Enable and start:

    sudo systemctl enable tinyproxy
    sudo systemctl restart tinyproxy
    sudo systemctl status tinyproxy

On Raspberry Pi, test through the VPS proxy:

    curl -I --proxy http://10.0.0.1:3128 https://api.namecheap.com/xml.response

When using this mode:

- Set `NAMECHEAP_CLIENT_IP` to your VPS public IPv4.
- Keep that VPS public IPv4 whitelisted in Namecheap API Access.

### Install Caddy with the Namecheap DNS module

The Debian `caddy` package does not include the Namecheap DNS provider module by default, so build Caddy with
`github.com/caddy-dns/namecheap`.

On Raspberry Pi:

    sudo apt update
    sudo apt install -y caddy golang-go
    go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
    ~/go/bin/xcaddy build --with github.com/caddy-dns/namecheap

Replace the packaged binary and verify module presence:

    sudo systemctl stop caddy
    sudo install -m 0755 ./caddy /usr/bin/caddy
    caddy list-modules | grep dns.providers.namecheap

Note: future `apt` upgrades of `caddy` may overwrite `/usr/bin/caddy`. Rebuild/reinstall the module-enabled binary if
the `namecheap` module disappears.

### Configure Caddy for DNS challenge

Create environment variables file:

    sudoedit /etc/caddy/namecheap.env

Set:

    NAMECHEAP_API_KEY=YOUR_NAMECHEAP_API_KEY
    NAMECHEAP_API_USER=YOUR_NAMECHEAP_USERNAME
    NAMECHEAP_CLIENT_IP=YOUR_WHITELISTED_PUBLIC_IP

Use `NAMECHEAP_CLIENT_IP` as follows:

- Direct mode: your home network public IPv4.
- VPS-proxy mode: your VPS public IPv4.

Create a systemd override to load that file:

    sudo systemctl edit caddy

For direct mode, use:

    [Service]
    EnvironmentFile=/etc/caddy/namecheap.env

For VPS-proxy mode, use:

    [Service]
    EnvironmentFile=/etc/caddy/namecheap.env
    Environment="HTTPS_PROXY=http://10.0.0.1:3128"
    Environment="HTTP_PROXY=http://10.0.0.1:3128"
    Environment="NO_PROXY=127.0.0.1,localhost,10.0.0.0/24"

Now configure `/etc/caddy/Caddyfile`:

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

    infumap.example.com {
        tls {
            dns namecheap {
                api_key {env.NAMECHEAP_API_KEY}
                user {env.NAMECHEAP_API_USER}
                api_endpoint https://api.namecheap.com/xml.response
                client_ip {env.NAMECHEAP_CLIENT_IP}
            }
        }
        reverse_proxy 127.0.0.1:8000
    }

Start and verify:

    sudo systemctl daemon-reload
    sudo systemctl enable caddy
    sudo systemctl restart caddy
    sudo systemctl status caddy

### Keep access VPN-only

On Raspberry Pi, keep inbound `443/tcp` restricted to the WireGuard subnet (as configured in the common guide):

    sudo ufw status verbose

On VPS, do not configure DNAT forwarding for `80/443` to the Raspberry Pi.

If you previously configured public forwarding rules, remove them and restart `nftables`.

### Verification

From a VPN-connected admin client:

    ping infumap.example.com
    curl -I https://infumap.example.com
    ssh pi@10.0.0.2

If TLS issuance fails, check Caddy logs:

    sudo journalctl -u caddy -n 200 --no-pager

### Profile-specific maintenance

- Direct mode: if your home public IP changes, update Namecheap API whitelist and `NAMECHEAP_CLIENT_IP`.
- VPS-proxy mode: keep the VPS public IP whitelisted in Namecheap; no home-IP updates are needed.
- Restart Caddy after changes:

    sudo systemctl restart caddy

- Re-check certificate and HTTPS reachability from a VPN client:

    curl -I https://infumap.example.com
