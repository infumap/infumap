
## Simple Deployment on Debian 11

_TODO: these notes are incomplete / very rough / probably flawed._

### Firewall Setup

Configure `ufw` (Uncomplicated Firewall) to allow HTTPS connections:

```
ufw allow 443
```

### Install / Configure Caddy

Install the `caddy` reverse proxy:

```
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Edit the Caddyfile: `/etc/caddy/Caddyfile`.
- change `:80` to your domain name.
- uncomment the `reverse_proxy` line.
- comment out the `root` line.

Then reload:

```
systemctl reload caddy
```
