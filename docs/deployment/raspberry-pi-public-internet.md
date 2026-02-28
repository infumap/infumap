## Raspberry Pi / VPN + Public Internet

Complete the shared [Raspberry Pi / VPN common setup](raspberry-pi.md) guide first. It covers the Raspberry Pi and VPS bootstrap, the WireGuard VPN, encryption, Infumap installation, and the periodic maintenance checklist. This document covers only the additional steps required to expose Infumap to the public internet through your VPS.


### Install Caddy on Your Raspberry Pi

To serve Infumap over HTTPS, you need a reverse proxy to terminate TLS. You can terminate TLS on either the VPS or the Raspberry Pi. This guide uses Caddy on the Raspberry Pi and uses the VPS only for WireGuard and packet forwarding. That keeps decrypted HTTP traffic off the VPS and reduces how much you need to trust the VPS infrastructure. Terminating TLS on the VPS can be operationally simpler, but it allows the VPS to inspect plaintext request and response traffic.

This guide uses [Caddy](https://caddyserver.com/) as the reverse proxy because it is simple to operate and automatically provisions and renews TLS certificates.

On your Raspberry Pi device:

    sudo apt update
    sudo apt install -y caddy

Contents of `/etc/caddy/Caddyfile`:

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

    YOUR_DOMAIN_NAME {
        reverse_proxy 127.0.0.1:8000
    }

Replace `YOUR_DOMAIN_NAME` with your domain name (for example, `example.com` or `infumap.example.com`).

Enable and start:

    sudo systemctl enable caddy
    sudo systemctl start caddy

If you want stronger isolation, consider running `caddy` on a separate physical device (for example, a second Raspberry Pi) or inside `docker` / `gvisor`.

### Expose Grafana at a Public Domain (Optional)

If you installed Grafana in the common guide and want it reachable on a dedicated public hostname (for example, `grafana.example.com`):

1. Create a public DNS record for that hostname pointing to your VPS public IP.
2. Add a second site block in `/etc/caddy/Caddyfile`:

       GRAFANA_DOMAIN_NAME {
           reverse_proxy 127.0.0.1:3000
       }

3. Reload Caddy:

       sudo systemctl reload caddy

4. Verify:

       curl -I https://GRAFANA_DOMAIN_NAME

Replace `GRAFANA_DOMAIN_NAME` with your actual Grafana hostname.
No additional VPS forwarding rules are required beyond the existing public `80/443` forwarding.


### Expose Infumap on VPS

First enable IP forwarding on the VPS so it can route packets between interfaces. Edit `/etc/sysctl.conf` and uncomment this line:

    net.ipv4.ip_forward=1

Then apply the change:

    sudo sysctl -p

Now add NAT rules under UFW control so public `80/443` traffic is forwarded to the Raspberry Pi over WireGuard:

    sudoedit /etc/ufw/before.rules

Add this block before the `*filter` section:

    *nat
    :PREROUTING ACCEPT [0:0]
    :POSTROUTING ACCEPT [0:0]
    -A PREROUTING -i PUBLIC_IFACE -p tcp --dport 80 -j DNAT --to-destination 10.0.0.2:80
    -A PREROUTING -i PUBLIC_IFACE -p tcp --dport 443 -j DNAT --to-destination 10.0.0.2:443
    -A POSTROUTING -o wg0 -p tcp -d 10.0.0.2 --dport 80 -j MASQUERADE
    -A POSTROUTING -o wg0 -p tcp -d 10.0.0.2 --dport 443 -j MASQUERADE
    COMMIT

On the Raspberry Pi, allow forwarded `80/443` traffic from the WireGuard subnet so Caddy can receive both HTTPS requests and HTTP ACME/redirect traffic:

    sudo ufw allow from 10.0.0.0/24 to any port 80 proto tcp
    sudo ufw allow from 10.0.0.0/24 to any port 443 proto tcp
    sudo ufw status verbose

Because the common guide sets `sudo ufw default deny routed` on the VPS, explicitly allow only forwarded web traffic to the Raspberry Pi:

    ip -o -4 route show to default
    sudo ufw reload
    sudo ufw route allow in on PUBLIC_IFACE out on wg0 to 10.0.0.2 port 80 proto tcp
    sudo ufw route allow in on PUBLIC_IFACE out on wg0 to 10.0.0.2 port 443 proto tcp
    sudo ufw status verbose

Replace `PUBLIC_IFACE` with your VPS internet-facing interface (often `eth0` or `ens3`).
If your WireGuard interface is not `wg0`, replace that as well.

If `curl -I https://` to your public IP succeeds but you still cannot reach the Raspberry Pi over the VPN (`10.0.0.2`), double-check that IP forwarding is still enabled (`net.ipv4.ip_forward`), that WireGuard is up on both ends, that the UFW NAT rules in `/etc/ufw/before.rules` are present, and that the UFW routed allow rules above are present.


### Network Robustness Test

Note the public IP of your home network. From the Raspberry Pi:

    curl -4 ifconfig.me

Note the Raspberry Pi's WLAN IP from your router's configuration page.

Power off your router for about five minutes. Then turn it back on and see whether everything recovers.

Note the new public and WLAN IPs and whether either one changed.

Periodic admin maintenance for both hosts is handled in the shared [Raspberry Pi / VPN common setup](raspberry-pi.md) guide (see the **Periodic Admin Maintenance** section there).
