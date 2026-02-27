## Raspberry Pi / VPN + Public Internet

Complete the shared [Raspberry Pi / VPN common setup](raspberry-pi.md) guide first. This covers the Raspberry Pi and VPS bootstrap, WireGuard VPN, encryption, Infumap installation, and the periodic maintenance checklist. This document only covers the extra steps required to expose Infumap to the public internet via your VPS.


### Install Caddy on Your Raspberry Pi

To serve Infumap over HTTPS, you need a reverse proxy to terminate TLS. You can terminate TLS on either the VPS or the Raspberry Pi. This guide uses Caddy on the Raspberry Pi and uses the VPS only for WireGuard and packet forwarding. That keeps decrypted HTTP traffic off the VPS and reduces trust in VPS infrastructure. Terminating TLS on the VPS can be operationally simpler, but it allows the VPS to inspect plaintext request/response traffic.

This guide uses [Caddy](https://caddyserver.com/) for the reverse proxy because it is simple to operate and automatically provisions and renews TLS certificates.

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

Where `YOUR_DOMAIN_NAME` is your domain name (e.g. `example.com` or `infumap.example.com`).

Enable and start:

    sudo systemctl enable caddy
    sudo systemctl start caddy

If you are extra paranoid, you might consider running `caddy` on a separate physical device (a second Raspberry Pi) or via `docker` / `gvisor` for better isolation.

### Expose Infumap on VPS

First enable IP forwarding on your server so it can route packets between interfaces. Edit `/etc/sysctl.conf` and uncomment the line:

    net.ipv4.ip_forward=1

Then apply the change:

    sudo sysctl -p

Now edit `/etc/nftables.conf` and set the contents to:

    #!/usr/sbin/nft -f

    flush ruleset

    table ip nat {
        chain prerouting {
            type nat hook prerouting priority -100; policy accept;
            tcp dport 443 dnat to 10.0.0.2
            tcp dport 80 dnat to 10.0.0.2
        }

        chain postrouting {
            type nat hook postrouting priority 100; policy accept;
            ip daddr 10.0.0.2 masquerade
        }
    }

Enable and start the nftables service:

    sudo systemctl enable nftables
    sudo systemctl start nftables

If `curl -I https://` to your public IP succeeds but you cannot reach the Raspberry Pi over the VPN (`10.0.0.2`), double-check that IP forwarding remains enabled (`net.ipv4.ip_forward`), that WireGuard is up on both ends, and that the nftables rules are loaded.

### Network Robustness Test

Note the public IP of your home network. From your Raspberry Pi:

    curl -4 ifconfig.me

Note your WLAN IP from the router configuration page.

Remove power from your router for about 5 minutes. Then turn it back on, and see if everything recovers.

Note the new public and WLAN IPs and whether they changed.

Periodic admin maintenance for both hosts is handled in the shared [Raspberry Pi / VPN common setup](raspberry-pi.md) guide (see the **Periodic Admin Maintenance** section there).
