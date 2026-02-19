
## Raspberry Pi / VPN

On a typical VPS, you must trust the hosting provider (and the underlying hardware and virtualization stack).
A sufficiently privileged operator may be able to access your VM’s disk and, in some cases, its memory,
potentially exposing secrets and plaintext.

If this risk is unacceptable, you can host Infumap on hardware you physically control. A Raspberry Pi 5 connected
to your home router is a low-cost option. However, most ISPs assign dynamic public IP addresses, and home networks
are typically behind NAT. As a result, making your Raspberry Pi accessible from the internet requires securely
routing traffic through a stable public IP address.

There are several ways to do this. A Cloudflare Zero Trust Tunnel is one convenient option, though it requires
running the `cloudflared` daemon and trusting Cloudflare’s infrastructure. Another approach is to establish a
WireGuard VPN between a low-cost VPS and your Raspberry Pi, forwarding HTTPS traffic through the VPS’s public IP.
This document outlines the latter approach.


### Initial Raspberry Pi Setup

Use the Raspberry Pi Imager to install a clean OS image.

- Select `Raspberry Pi OS Lite (64-bit)` (in Imager this is under `Raspberry Pi OS (other)`).
- Enable the SSH service and use public-key authentication as this is more secure than password authentication.
- Turn off telemetry.

After first boot, find the Raspberry Pi's LAN IP address by checking your router's DHCP client/lease table (sometimes
called the LAN hosts page) in the router admin interface. Then:

    ssh pi@<ip address>

(optional) Disable additional services commonly unnecessary for a headless Infumap host:

    sudo systemctl disable --now avahi-daemon.service avahi-daemon.socket 2>/dev/null || true
    sudo systemctl disable --now triggerhappy.service 2>/dev/null || true
    sudo systemctl disable --now ModemManager.service 2>/dev/null || true
    sudo systemctl disable --now cups.service cups-browsed.service 2>/dev/null || true

(optional, Ethernet-only) Disable Wi-Fi userspace management:

    sudo systemctl disable --now wpa_supplicant.service 2>/dev/null || true

(optional) Configure `journald` for RAM-only logs. This keeps diagnostics available for live troubleshooting
while avoiding persistent log growth on disk:

    # in /etc/systemd/journald.conf
    Storage=volatile
    RuntimeMaxUse=8M
    Compress=yes

Then restart and verify:

    sudo systemctl restart systemd-journald
    journalctl --disk-usage

(optional, Ethernet-only and no audio use) Reduce hardware/software attack surface by adding the following to `/boot/firmware/config.txt`:

    dtoverlay=disable-bt
    dtoverlay=disable-wifi
    dtparam=audio=off

Install prerequisites:

    sudo apt update
    sudo apt upgrade
    sudo apt install tmux ufw wireguard

### Raspberry Pi Firewall and SSH Access Policy

Use UFW to deny all inbound traffic by default, then explicitly allow required ports.

Note: This assumes you will be setting up your wireguard network interface on 10.0.0.0/24. If this clashes with your router,
or some other local network configuration, you will need to change it to something that doesn't.

Simple SSH policy (allows SSH from anywhere):

    sudo ufw reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22
    sudo ufw allow from 10.0.0.0/24 to any port 443 proto tcp
    sudo ufw enable

Note: apply the simple policy now. The VPN-specific SSH allowlist rule should be applied later, after WireGuard
peer IP assignments are complete and your admin host has a stable VPN IP.

Recommended tighter SSH policy (LAN + one admin host on VPN subnet):

    sudo ufw reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow from YOUR_LOCAL_SUBNET to any port 22 proto tcp
    sudo ufw allow from ADMIN_VPN_HOST_IP/32 to any port 22 proto tcp
    sudo ufw allow from 10.0.0.0/24 to any port 443 proto tcp
    sudo ufw enable

Where:

- `YOUR_LOCAL_SUBNET` is your local LAN in CIDR notation (e.g. `192.168.0.0/16`).
- `ADMIN_VPN_HOST_IP` is the WireGuard IP assigned to your admin laptop/workstation (e.g. `10.0.0.10`).

With the tighter policy, remote administration is still possible from that specific VPN host, including after reboot when a LUKS
volume must be unlocked. Because SSH is allowlisted to the admin host IP (and not the full VPN subnet), compromise of the VPS
or another VPN peer does not by itself grant SSH access to the Raspberry Pi.

### Infumap Install

After setting up the firewall, build infumap from source.

First install rust:

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

Now clone the infumap repo:

    cd ~
    mkdir git
    cd git
    git clone https://github.com/infumap/infumap.git
    cd infumap
    git checkout v0.3.0

Determine the latest version of `nvm` here https://github.com/nvm-sh/nvm (at the time of writing 0.40.1) and install similar to:

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    nvm install node

Finally build Infumap:

    ./build.sh

And copy to somewhere on the current `PATH`:

    sudo cp ~/git/infumap/infumap/target/release/infumap /usr/local/bin/


### Initial VPS Setup

Create a VPS running Debian 12 x64 using your vendor of choice. Select a region as physically close to your Raspberry
Pi device as possible.

A cheap/small instance size will suffice since we will not use the VPS instance for anything other than forwarding
through HTTPS web traffic to/from the Raspberry Pi device.

Use public-key authentication, with a different key to your Raspberry Pi.

Install prerequisites:

    apt update && sudo apt upgrade
    apt install wireguard

We will use wireguard to create a secure, persistent, reliable network between our VPS instance and Raspberry Pi.

Generate the VPS wireguard keys:

    sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/server.key | wg pubkey > /etc/wireguard/keys/server.key.pub

Create the wireguard config file:

    nano /etc/wireguard/wg0.conf

    [Interface]
    Address = 10.0.0.1/32
    ListenPort = 51820
    PrivateKey = {YOUR_SERVER_PRIVATE_KEY}
    SaveConfig = false

Lock down the permissions of the server private key and config:

    sudo chmod 600 /etc/wireguard/wg0.conf /etc/wireguard/keys/server.key

Disable ssh password based login:
    
    sudo vi /etc/ssh/sshd_config
  
and set:

    PasswordAuthentication no
    UsePAM no

Also check for config files in `/etc/ssh/sshd_config.d` that may override `/etc/ssh/sshd_config` and update if required.

Restart SSH server

    sudo systemctl reload ssh

### Raspberry Pi Wireguard Setup

Install wireguard:

    apt update
    apt install openresolv net-tools wireguard

Generate wireguard keys for your Raspberry PI instance:

    sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/client.key | wg pubkey | sudo tee /etc/wireguard/keys/client.key.pub > /dev/null

Create the wg0 interface config:

    sudo nano /etc/wireguard/wg0.conf

    [Interface]
    PrivateKey = {YOUR_CLIENT_PRIVATE_KEY}
    Address = 10.0.0.2/24
    SaveConfig = false

    [Peer]
    PublicKey = {YOUR_SERVER_PUBLIC_KEY}
    AllowedIPs = 10.0.0.0/24
    Endpoint = {YOUR_SERVER_INTERNET_IP}:51820
    PersistentKeepalive = 25

Lock down the permissions of the client private key and config:

    sudo chmod 600 /etc/wireguard/wg0.conf /etc/wireguard/keys/client.key

Automatically bring up the wg0 VPN interface on boot:

    sudo systemctl enable wg-quick@wg0

Start wg0 up now:

    sudo systemctl start wg-quick@wg0


### Finalize VPS WireGuard Setup

Now, on the VPS, add your Raspberry Pi as a peer:

    nano /etc/wireguard/wg0.conf

    [Interface]
    Address = 10.0.0.1/32
    ListenPort = 51820
    PrivateKey = {YOUR_SERVER_PRIVATE_KEY}
    SaveConfig = false

    [Peer]
    PublicKey = {YOUR_CLIENT_PUBLIC_KEY}
    AllowedIPs = 10.0.0.2/32

Automatically bring up the `wg0` VPN interface on boot:

    systemctl enable wg-quick@wg0

And start `wg0` now:

    systemctl start wg-quick@wg0

Verify it's up:

    wg show wg0


### Setup A WireGuard Monitoring Service

With the above setup, the Raspberry Pi may occasionally become unreachable over the WireGuard network,
sometimes indefinitely until manual intervention. As a workaround, use a small watchdog script that
monitors reachability to the VPS over `wg0` and restarts the WireGuard service when required.

Install `infumap/tools/wg-monitor.sh` as a root-owned executable:

    sudo install -o root -g root -m 0755 ~/git/infumap/tools/wg-monitor.sh /usr/local/bin/wg-monitor.sh

Create and lock down a log file:

    sudo touch /var/log/wg-monitor.log
    sudo chown root:root /var/log/wg-monitor.log
    sudo chmod 0600 /var/log/wg-monitor.log

Create a file `/etc/systemd/system/wg-monitor.service` with the following text:

    [Unit]
    Description=Monitor WireGuard Service
    Wants=network-online.target
    After=network-online.target wg-quick@wg0.service

    [Service]
    Type=simple
    User=root
    Group=root
    ExecStart=/usr/local/bin/wg-monitor.sh 10.0.0.1 /var/log/wg-monitor.log
    Restart=always
    RestartSec=10
    NoNewPrivileges=yes
    PrivateTmp=yes
    ProtectSystem=full
    ProtectHome=yes
    ProtectControlGroups=yes
    ProtectKernelModules=yes
    ProtectKernelTunables=yes
    ProtectKernelLogs=yes
    RestrictSUIDSGID=yes
    LockPersonality=yes
    MemoryDenyWriteExecute=yes
    RestrictRealtime=yes
    SystemCallArchitectures=native

    [Install]
    WantedBy=multi-user.target

Set ownership and permissions on the systemd unit file:

    sudo chown root:root /etc/systemd/system/wg-monitor.service
    sudo chmod 0644 /etc/systemd/system/wg-monitor.service

Reload systemd, enable, and start:

    sudo systemctl daemon-reload
    sudo systemctl enable wg-monitor.service
    sudo systemctl start wg-monitor.service

Check status and recent logs:

    sudo systemctl status wg-monitor.service
    sudo tail -n 100 /var/log/wg-monitor.log


### Setup Encrypted drive

Create an encrypted volume on your Raspberry Pi to ensure that even if an attacker gains physical access to it,
they cannot read your Infumap instance data.

On your Raspberry Pi:

    sudo apt-get install cryptsetup

Check available bytes:

    df -k

The Raspberry Pi 5 kit comes with a 32 Gb flash drive. If you are using this, a 16Gb encrypted volume is appropriate.
In `/root`, create this file with random data:

    dd if=/dev/urandom of=enc_volume.img bs=1M count=16384 status=progress

Format this file as a LUKS container:

    sudo cryptsetup luksFormat enc_volume.img

Open the container:

    sudo cryptsetup luksOpen enc_volume.img infuvol

Create a filesystem:

    sudo mkfs.ext4 /dev/mapper/infuvol

Create a mount point:

    sudo mkdir /mnt/infudata

And finally mount:

    sudo mount /dev/mapper/infuvol /mnt/infudata

You can unmount and close the LUKS container with:

    sudo umount /mnt/infudata
    sudo cryptsetup luksClose infuvol

If you use a LUKS volume for Infumap data, you must manually unlock and mount it after each reboot.
This is covered in the `Periodic Admin Maintenance` section below.


### Configure and Run Infumap:

The easiest way to create a default settings file is to simply run infumap:

    infumap web
    Ctrl-C

The settings file will be created in `~/.infumap`. Move this into the encrypted drive:

    sudo mv ~/.infumap/* /mnt/infudata

Update [settings.toml](../configuration.md) as desired. At a minimum, update the data and cache dirs and max cache size:

    data_dir = "/mnt/infudata/data"
    cache_dir = "/mnt/infudata/cache"
    cache_max_mb = 12000

A cache size of about 12Gb is appropriate if you use an object store, rather than local disk for data storage. For more
information, refer to the [configuration](../configuration.md) guide.

Since the encrypted drive used by Infumap needs to be manually mounted on reboot, there is little benefit to creating a
service to manage Infumap. I just run it in a `tmux` session.

Start a new `tmux` session:

    tmux

Run Infumap:

    infumap web --settings /mnt/infudata/settings.toml

Key tmux commands to be aware of:

    Ctrl-b-s (list sessions)
    Ctrl-b-d (detach)
    Ctrl-b-a (attach)


### Install Caddy on Your Raspberry Pi

In order to serve infumap over HTTPS, you'll need to use a reverse proxy. You can run this on either your VPS instance
or Raspberry Pi. An advantage of running it on the VPS is isolation from the `infumap` processes, particularly if you've
disabled `ssh` access to your Raspberry Pi over the WireGuard network. It is also easier to set up. However, a significant
downside is that unencrypted data from your Infumap instance will be exposed to the VPS as requests are served. This data
is partial and transient, so the security implications are not as big as if the entire data set were available on the
VPS at rest. Still, it is preferable to avoid this.

We will use [Caddy](https://caddyserver.com/) for the reverse proxy because it is very easy to use - automatically provisions
the TLS certificate and keeps it renewed.

On your Raspberry Pi device:

    sudo apt install caddy

Contents of `/etc/caddy/Caddyfile`:

    {
        log {
            output file /var/log/caddy/access.log
            format json
        }
    }

    YOUR_DOMAIN_NAME {
        reverse_proxy 127.0.0.1:8000
    }

Where YOUR_DOMAIN_NAME is your domain name, e.g. `example.com` or `infumap.example.com`.

Enable and start:

    systemctl enable caddy
    systemctl start caddy

If you are extra paranoid, you might consider running `caddy` on a separate physical device (a second Raspberry Pi) or
via `docker` / `gvisor` for better isolation.


### Expose Infumap on VPS

First enable IP forwarding on your server to allow it to route packets between interfaces. Edit `/etc/sysctl.conf` and uncomment the line:

    net.ipv4.ip_forward=1

Then

    sysctl -p

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

    systemctl enable nftables
    systemctl start nftables


### Network Robustness Test

Note the public IP of your home network. From your Raspberry Pi:

    curl -4 ifconfig.me

Note your WLAN IP from router the router configuration page.

Remove power from your router for about 5 minutes. Then turn it back on, and see if everything recovers.

Note the new public and WLAN IPs and whether they changed.


### Periodic Admin Maintenance

Apply operating system security updates and perform a basic health check on a regular schedule (monthly is a good default).

On Raspberry Pi:

    sudo apt update
    sudo apt upgrade -y
    sudo apt autoremove -y
    sudo apt autoclean

On VPS:

    sudo apt update
    sudo apt upgrade -y
    sudo apt autoremove -y
    sudo apt autoclean

If a reboot is required on either host:

    test -f /var/run/reboot-required && echo "reboot required"
    sudo reboot

If your Infumap data is on a LUKS volume, after the Raspberry Pi reboots:

    sudo cryptsetup luksOpen enc_volume.img infuvol
    sudo mount /dev/mapper/infuvol /mnt/infudata

You will be prompted for the LUKS passphrase. This manual step is intentional: automating unlock reduces protection against physical device access.

After updates/reboots, verify service health.

On Raspberry Pi:

    sudo systemctl is-active wg-quick@wg0
    sudo systemctl is-active wg-monitor.service
    sudo systemctl is-active caddy
    sudo wg show wg0
    sudo tail -n 100 /var/log/wg-monitor.log

On VPS:

    sudo systemctl is-active wg-quick@wg0
    sudo systemctl is-active nftables
    sudo wg show wg0

Check storage usage:

    df -h
    sudo journalctl --disk-usage
