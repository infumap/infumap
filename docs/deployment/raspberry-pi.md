## Raspberry Pi / VPN (Common Setup)

Running Infumap on a typical VPS means trusting the hosting provider. A sufficiently privileged operator may be able to
access your VM’s disk and, in many cases, its memory. If you do not want to place that level of trust in a VPS provider,
you can host Infumap on hardware you physically control, such as a Raspberry Pi 5 on your home network. The main challenge
is connectivity: most ISPs assign dynamic public IP addresses, and home networks are usually behind NAT. To make your
Raspberry Pi reachable from the internet, you need to route traffic securely through a host with a stable public IP address.

There are several ways to do this. A Cloudflare Zero Trust Tunnel is one convenient option, though it requires
running the `cloudflared` daemon and trusting Cloudflare’s infrastructure. A more secure approach is to establish
a WireGuard VPN between a low-cost VPS and your Raspberry Pi, forwarding HTTPS traffic unmodified through the VPS’s
public IP. This document outlines the latter approach.


### Initial Raspberry Pi Setup

Use the Raspberry Pi Imager to install a clean OS image.

- On your admin machine, generate a dedicated SSH keypair for the Raspberry Pi:

      ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_infumap_pi_ed25519 -C "infumap-pi"

  When Raspberry Pi Imager asks for an authorized key for SSH, paste the contents of `~/.ssh/infumap_pi_ed25519.pub`.
- Select `Raspberry Pi OS Lite (64-bit)` (in Imager this is under `Raspberry Pi OS (other)`).
- Set the hostname to `infumap-pi`.
- Enable SSH and use public-key authentication (more secure than password authentication).
- Turn off telemetry.

After first boot, find the Raspberry Pi's LAN IP address by checking your router's DHCP client/lease table (sometimes
called the LAN hosts page) in the router admin interface. Then:

    ssh -i ~/.ssh/id_infumap_pi_ed25519 pi@<ip address>

Install prerequisites:

    sudo apt update
    sudo apt upgrade
    sudo apt install git ufw wireguard

Raspberry Pi OS ships with a default `pi` account and passwordless `sudo`. Replace this with a dedicated admin
account (`infumap`) and disable SSH access for `pi`.

On the Raspberry Pi (while still logged in as `pi`), create the `infumap` user:

    sudo adduser --gecos "" infumap
    sudo usermod -aG sudo infumap
    sudo install -d -m 700 -o infumap -g infumap /home/infumap/.ssh
    sudo cp /home/pi/.ssh/authorized_keys /home/infumap/.ssh/authorized_keys
    sudo chown infumap:infumap /home/infumap/.ssh/authorized_keys
    sudo chmod 600 /home/infumap/.ssh/authorized_keys

Disable passwordless sudo for `pi` (if `/etc/sudoers.d/010_pi-nopasswd` exists):

    sudoedit /etc/sudoers.d/010_pi-nopasswd

Replace its contents with:

    pi ALL=(ALL:ALL) ALL

Restrict SSH login to the admin user:

    sudoedit /etc/ssh/sshd_config.d/99-admin-users.conf

Add:

    AllowUsers infumap

Require public-key authentication for SSH on the Raspberry Pi:

    sudoedit /etc/ssh/sshd_config.d/99-auth-hardening.conf

Add:

    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitRootLogin no
    PubkeyAuthentication yes
    X11Forwarding no

If Raspberry Pi OS ships additional files in `/etc/ssh/sshd_config.d`, make sure none of them override these settings.

Validate and reload SSH:

    sudo sshd -t
    sudo systemctl reload ssh

Open a new terminal and verify admin login before closing the original session:

    ssh -i ~/.ssh/infumap_pi_ed25519 infumap@<ip address>
    sudo -k
    sudo true

SSH should succeed with your key only. If `ssh -i ~/.ssh/infumap_pi_ed25519 infumap@<ip address>` offers password or keyboard-interactive login, stop and re-check the SSH drop-in files before continuing.

After successful verification, remove the copied key material from the old `pi` account:

    sudo rm -f /home/pi/.ssh/authorized_keys

Then lock `pi` and disable its interactive shell:

    sudo passwd -l pi
    sudo usermod -s /usr/sbin/nologin pi

Continue the rest of this guide as `infumap`.

(optional) Disable additional services that are usually unnecessary on a headless Infumap host:

    sudo systemctl disable --now avahi-daemon.service avahi-daemon.socket 2>/dev/null || true
    sudo systemctl disable --now triggerhappy.service 2>/dev/null || true
    sudo systemctl disable --now ModemManager.service 2>/dev/null || true
    sudo systemctl disable --now cups.service cups-browsed.service 2>/dev/null || true

(optional, if installed) Disable and remove Raspberry Pi Connect (cloud remote access):

    sudo systemctl disable --now rpi-connect.service 2>/dev/null || true
    sudo apt purge -y rpi-connect || true
    sudo apt purge -y rpi-connect-lite || true
    sudo apt autoremove -y

(optional) Add disk-usage limits on logs/core dumps to conserve space on the Raspberry Pi:

Edit `/etc/systemd/journald.conf`:

    sudoedit /etc/systemd/journald.conf

and set:

    Storage=volatile
    RuntimeMaxUse=4M
    Compress=yes

Disable apt package cache retention and apply the changes:

    echo 'Binary::apt::APT::Keep-Downloaded-Packages "false";' | sudo tee /etc/apt/apt.conf.d/99infumap-no-cache > /dev/null
    sudo apt clean
    sudo systemctl restart systemd-journald
    sudo journalctl --rotate
    sudo journalctl --vacuum-size=4M
    sudo journalctl --disk-usage

Remove old persistent journal files created before `Storage=volatile`:

    sudo rm -rf /var/log/journal
    sudo systemctl restart systemd-journald
    sudo journalctl --disk-usage

This global `journald` limit applies to most services. Infumap can still keep longer on-disk logs through a dedicated log file configured later in this guide.

(optional, if installed) Disable `rsyslog` to avoid duplicate on-disk log streams:

    sudo systemctl disable --now rsyslog.service 2>/dev/null || true

Recovery note: for severe or unclear failures, rebuild the Pi and restore from backup.

(optional, Ethernet-only and no audio use) Reduce the hardware/software attack surface by editing `/boot/firmware/config.txt`:

    sudoedit /boot/firmware/config.txt

Append the following lines near the end of the file. If the file already has section headers such as `[all]`, put these lines under the final `[all]` section rather than inside a model-specific section like `[pi4]`:

    dtoverlay=disable-bt
    dtoverlay=disable-wifi
    dtparam=audio=off

Apply related service-level disables:

    sudo systemctl disable --now wpa_supplicant.service 2>/dev/null || true
    sudo systemctl disable --now bluetooth.service hciuart.service 2>/dev/null || true

Because `/boot/firmware/config.txt` changes apply only after reboot, reboot now and reconnect over Ethernet SSH:

    sudo reboot

### Raspberry Pi Firewall and SSH Access Policy

Use UFW to deny all inbound traffic by default, then explicitly allow required ports.

Note: This guide assumes your WireGuard network is `10.0.0.0/24`. If that conflicts with your router or another local network, use a different private subnet.

Baseline SSH policy (LAN only):

    sudo ufw reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow from YOUR_LOCAL_SUBNET to any port 22 proto tcp
    sudo ufw allow from 10.0.0.0/24 to any port 443 proto tcp
    sudo ufw enable

Where `YOUR_LOCAL_SUBNET` is your local LAN in CIDR notation (e.g. `192.168.0.0/16`).

Apply this baseline policy now. After WireGuard peer IP assignments are complete and your admin host has a stable VPN IP, add the admin VPN SSH allow rule in the admin client setup section.


### Infumap Install

After setting up the firewall, build Infumap from source.

Before executing any third-party bootstrap script, download it first and inspect it locally. This does not remove supply-chain risk, but it is better than `curl ... | sh` because you get a stable artifact to review and can rerun the exact same file you inspected.

First install Rust by downloading the official `rustup` bootstrap script, inspecting it, then running it manually:

    curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init.sh https://sh.rustup.rs
    less /tmp/rustup-init.sh
    sh /tmp/rustup-init.sh
    rm /tmp/rustup-init.sh

Now clone the Infumap repo:

    cd ~
    mkdir -p git
    cd git
    git clone https://github.com/infumap/infumap.git
    cd infumap

Cloning downloads the source without executing it. If you want a review point before the build, inspect project scripts such as `build.sh`.

Find the exact `nvm` release you want to install at https://github.com/nvm-sh/nvm (for example, `v0.40.4`), then download that specific installer, inspect it, and run it:

    curl -fsSLo /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh
    less /tmp/nvm-install.sh
    bash /tmp/nvm-install.sh
    rm /tmp/nvm-install.sh

Log out and log back in so your shell picks up the `nvm` initialization added by the installer. Then install and use the repo-pinned Node.js version from `.nvmrc`:

    exit
    ssh -i ~/.ssh/infumap_pi_ed25519 infumap@<ip address>
    cd ~/git/infumap
    nvm install
    nvm use

If you want to check current npm advisories explicitly, do it as a separate step instead of relying on build-time install output:

    cd ~/git/infumap/web
    npm audit
    cd ~/git/infumap

Finally build Infumap:

    ./build.sh

Install the release binary to a stable, root-owned path:

    sudo install -d -m 0755 /opt/infumap/bin
    sudo install -m 0755 ~/git/infumap/infumap/target/release/infumap /opt/infumap/bin/infumap


### Initial VPS Setup

Create a Debian 13 x64 VPS from your preferred vendor. Choose a region physically close to your Raspberry Pi. A small, low-cost instance is enough because the VPS is only forwarding HTTPS traffic.

Install required packages:

    sudo apt update
    sudo apt upgrade -y
    sudo apt install --no-install-recommends wireguard-tools ufw

(optional) If prompted, run `sudo apt autoremove` to remove packages marked as no longer required.

Configure and enable the VPS firewall:

    sudo ufw --force reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw default deny routed
    sudo ufw allow 22/tcp
    sudo ufw allow 43821/udp
    sudo ufw --force enable
    sudo ufw status verbose

This guide uses `43821/udp` for WireGuard instead of the common default `51820/udp` to reduce opportunistic default-port scan noise. Choose any unused high UDP port in `1024-65535`, then use the same port consistently in:
VPS UFW rules, VPS `ListenPort`, and every client `Endpoint`.

`sudo ufw default deny routed` is set as a secure baseline. `wg0` -> `wg0` routed allow rules for VPN peer access are added in a later section. If you later choose the public internet-facing profile, explicit routed allow rules for forwarded `80/443` traffic to `10.0.0.2` are added there.

Enable IPv4 forwarding on the VPS now so it can route traffic between WireGuard peers and, if needed later, between the public interface and `wg0`:

    sudoedit /etc/sysctl.conf

Uncomment or add:

    net.ipv4.ip_forward=1

Then apply the change:

    sudo sysctl -p

(optional) Add disk-usage limits on logs/core dumps to conserve disk space:

Note: This is mainly useful if you use spare VPS capacity for additional non-core tasks. If you do, review the security impact of every extra service you install and run.

Edit `/etc/systemd/journald.conf`:

    sudoedit /etc/systemd/journald.conf

and set:

    Storage=volatile
    RuntimeMaxUse=4M
    Compress=yes

Create `/etc/systemd/coredump.conf.d/99-infumap.conf`:

    sudo install -d -m 755 /etc/systemd/coredump.conf.d
    sudoedit /etc/systemd/coredump.conf.d/99-infumap.conf

with:

    [Coredump]
    Storage=none
    ProcessSizeMax=0

Disable apt package cache retention and apply the changes:

    echo 'Binary::apt::APT::Keep-Downloaded-Packages "false";' | sudo tee /etc/apt/apt.conf.d/99infumap-no-cache > /dev/null
    sudo apt clean
    sudo systemctl restart systemd-journald
    sudo journalctl --rotate
    sudo journalctl --vacuum-size=4M
    sudo journalctl --disk-usage

Remove old persistent journal files created before `Storage=volatile`:

    sudo rm -rf /var/log/journal
    sudo systemctl restart systemd-journald
    sudo journalctl --disk-usage

(optional, if installed) Disable `rsyslog` to avoid duplicate on-disk log streams:

    sudo systemctl disable --now rsyslog.service 2>/dev/null || true

On your admin machine, generate a new dedicated SSH keypair for this VPS (run locally, not on the VPS):

    ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_infumap_vps -C "infumap-vps"

Display the public key so you can copy it:

    cat ~/.ssh/id_infumap_vps.pub

You will paste this value as `YOUR_ADMIN_PUBLIC_KEY` in the user setup step below.

Using a new key here lowers risk from leaked bootstrap credentials or provider account compromise, though it does not remove the need to trust the VPS provider.

Create a non-root admin user for ongoing administration:

    sudo adduser --gecos "" infumap
    sudo usermod -aG sudo infumap
    sudo install -d -m 700 -o infumap -g infumap /home/infumap/.ssh
    echo "{YOUR_ADMIN_PUBLIC_KEY}" | sudo tee /home/infumap/.ssh/authorized_keys > /dev/null
    sudo chown infumap:infumap /home/infumap/.ssh/authorized_keys
    sudo chmod 600 /home/infumap/.ssh/authorized_keys

Where `YOUR_ADMIN_PUBLIC_KEY` is a full public key line from your admin machine (for example: `ssh-ed25519 AAAA... you@laptop`).

Set a strong password for `infumap` when prompted. This password is for `sudo` and console recovery; SSH password authentication is disabled later.

Verify login in a new terminal before continuing:

    ssh -i ~/.ssh/id_infumap_vps infumap@{YOUR_SERVER_INTERNET_IP}
    sudo -v

After confirming `infumap` works, remove provider bootstrap root credentials:

    sudo truncate -s 0 /root/.ssh/authorized_keys
    sudo passwd -l root

After confirming `infumap` login works, harden SSH:
    
    sudoedit /etc/ssh/sshd_config
  
and set:

    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitRootLogin no
    X11Forwarding no
    UsePAM yes

Also check for config files in `/etc/ssh/sshd_config.d` that may override `/etc/ssh/sshd_config` and update if required.

If present, keep `AcceptEnv LANG LC_* COLORTERM NO_COLOR` so locale and color environment variables can pass through SSH.
Also keep the existing `Subsystem sftp ...` entry so `scp` keeps working.

Validate and reload SSH server:

    sudo sshd -t
    sudo systemctl reload ssh

Use WireGuard to create a secure, persistent link between the VPS and Raspberry Pi.

Generate the VPS WireGuard keys:

    sudo install -d -m 700 /etc/wireguard/keys
    wg genkey | sudo tee /etc/wireguard/keys/server.key | wg pubkey | sudo tee /etc/wireguard/keys/server.key.pub > /dev/null

Create the WireGuard config file:

    sudoedit /etc/wireguard/wg0.conf

    [Interface]
    Address = 10.0.0.1/32
    ListenPort = 43821
    PrivateKey = {contents of /etc/wireguard/keys/server.key}
    SaveConfig = false

Lock down the permissions of the server keys and config:

    sudo chmod 600 /etc/wireguard/wg0.conf /etc/wireguard/keys/server.key
    sudo chmod 644 /etc/wireguard/keys/server.key.pub


### Raspberry Pi WireGuard Setup

Install WireGuard:

    sudo apt update
    sudo apt install -y openresolv net-tools wireguard

Generate WireGuard keys for the Raspberry Pi:

    sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/client.key | wg pubkey | sudo tee /etc/wireguard/keys/client.key.pub > /dev/null

Create the wg0 interface config:

    sudoedit /etc/wireguard/wg0.conf

    [Interface]
    PrivateKey = {YOUR_CLIENT_PRIVATE_KEY}
    Address = 10.0.0.2/24
    SaveConfig = false

    [Peer]
    PublicKey = {YOUR_SERVER_PUBLIC_KEY}
    AllowedIPs = 10.0.0.0/24
    Endpoint = {YOUR_SERVER_INTERNET_IP}:43821
    PersistentKeepalive = 25

Lock down the permissions of the client private key and config:

    sudo chmod 600 /etc/wireguard/wg0.conf /etc/wireguard/keys/client.key

Automatically bring up the wg0 VPN interface on boot:

    sudo systemctl enable wg-quick@wg0

Start `wg0` now:

    sudo systemctl start wg-quick@wg0


### Finalize VPS WireGuard Setup

Now, on the VPS, add your Raspberry Pi as a peer:

    sudoedit /etc/wireguard/wg0.conf

    [Interface]
    Address = 10.0.0.1/32
    ListenPort = 43821
    PrivateKey = {contents of /etc/wireguard/keys/server.key}
    SaveConfig = false

    [Peer]
    PublicKey = {YOUR_CLIENT_PUBLIC_KEY}
    AllowedIPs = 10.0.0.2/32

Automatically bring up the `wg0` VPN interface on boot:

    sudo systemctl enable wg-quick@wg0

And start `wg0` now:

    sudo systemctl start wg-quick@wg0

Verify it's up:

    sudo wg show wg0


### Set Up a macOS WireGuard Admin Client (Full VPN Access)

Set up your admin Mac to join the same WireGuard VPN and reach all peers (for example, `10.0.0.1` on the VPS and `10.0.0.2` on the Raspberry Pi).
The same model works on other WireGuard client platforms (Windows, Linux, iOS, Android), but this guide documents only macOS.

Install the [WireGuard macOS app](https://www.wireguard.com/install/) and create a new tunnel from scratch.
In the tunnel editor, click **Generate** for the interface private key.

Use the generated interface public key as `YOUR_MAC_PUBLIC_KEY` in the VPS peer config below.
Use `YOUR_SERVER_PUBLIC_KEY` from the VPS file `/etc/wireguard/keys/server.key.pub`.
Keep the generated private key on your Mac (do not copy it to the VPS).

Use a config like:

    [Interface]
    PrivateKey = {GENERATED_BY_WIREGUARD_MAC_APP}
    Address = 10.0.0.10/24
    SaveConfig = false

    [Peer]
    PublicKey = {YOUR_SERVER_PUBLIC_KEY}
    AllowedIPs = 10.0.0.0/24
    Endpoint = {YOUR_SERVER_INTERNET_IP}:43821
    PersistentKeepalive = 25

Now add the Mac as a peer on the VPS (`/etc/wireguard/wg0.conf`):

    [Peer]
    PublicKey = {YOUR_MAC_PUBLIC_KEY}
    AllowedIPs = 10.0.0.10/32

Restart WireGuard on the VPS:

    sudo systemctl restart wg-quick@wg0

Now add SSH access for the admin VPN host on the Raspberry Pi:

    sudo ufw allow from ADMIN_VPN_HOST_IP/32 to any port 22 proto tcp
    sudo ufw status verbose

Where `ADMIN_VPN_HOST_IP` is the WireGuard IP assigned to your admin laptop/workstation (e.g. `10.0.0.10`).

With this policy, remote administration is possible from your specific admin VPN host, including after reboot when you need to unlock the LUKS volume. Because SSH is allowlisted to the admin host IP (not the full VPN subnet), compromise of the VPS or another VPN peer does not by itself grant SSH access to the Raspberry Pi.

Because the VPS firewall baseline is `sudo ufw default deny routed`, add explicit `wg0` -> `wg0` routed allow rules
for admin access to the Raspberry Pi:

    sudo ufw route allow in on wg0 out on wg0 from 10.0.0.10/32 to 10.0.0.2 port 22 proto tcp
    sudo ufw route allow in on wg0 out on wg0 from 10.0.0.0/24 to 10.0.0.2 port 443 proto tcp
    sudo ufw status verbose

Replace `10.0.0.10/32` with your admin client WireGuard IP in CIDR notation.
The HTTPS rule intentionally allows all VPN peers (`10.0.0.0/24`) to reach the Raspberry Pi web service.

Bring the tunnel up on macOS and verify:

    ping 10.0.0.1
    ping 10.0.0.2
    ssh infumap@10.0.0.2

If `10.0.0.1` works but `10.0.0.2` does not, confirm these routed allow rules are present and that the source IP matches your admin tunnel IP.


### Set Up a WireGuard Monitoring Service

With this setup, the Raspberry Pi may occasionally become unreachable over WireGuard, sometimes until manual intervention. As a workaround, use a small watchdog script that monitors reachability to the VPS over `wg0` and restarts WireGuard when needed.

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


### Set Up an Encrypted Drive

Create an encrypted volume on your Raspberry Pi so that even if an attacker gains physical access, they still cannot read your Infumap data.

On your Raspberry Pi:

    sudo apt-get install cryptsetup

Check available disk space:

    df -k

The Raspberry Pi 5 kit often includes 32 GB of storage. If you are using that size, a 16 GB encrypted volume is a reasonable default.
In `/home/infumap`, create this file with random data:

    sudo dd if=/dev/urandom of=/home/infumap/enc_volume.img bs=1M count=16384 status=progress

Format this file as a LUKS container:

    sudo cryptsetup luksFormat /home/infumap/enc_volume.img

Open the container:

    sudo cryptsetup luksOpen /home/infumap/enc_volume.img infuvol

Create a filesystem:

    sudo mkfs.ext4 /dev/mapper/infuvol

Create a mount point:

    sudo mkdir /mnt/infudata

Then mount it:

    sudo mount /dev/mapper/infuvol /mnt/infudata

You can unmount and close the LUKS container with:

    sudo umount /mnt/infudata
    sudo cryptsetup luksClose infuvol

If you use a LUKS volume for Infumap data, you must manually unlock and mount it after each reboot.
Include this in your periodic maintenance runbook.


### Configure and Run Infumap

Create a dedicated unprivileged service user for the Infumap process:

    sudo adduser --system --group --home /var/lib/infumapd infumapd

The easiest way to create a default settings file is to run the Infumap binary once:

    /opt/infumap/bin/infumap web
    Ctrl-C

The settings file is created in `~/.infumap`. Move it to the encrypted drive:

    sudo mv ~/.infumap/* /mnt/infudata
    sudo chown -R infumapd:infumapd /mnt/infudata
    sudo chmod 750 /mnt/infudata

Update [settings.toml](../configuration.md) as needed. At minimum, set the data and cache directories and max cache size:

    data_dir = "/mnt/infudata/data"
    cache_dir = "/mnt/infudata/cache"
    cache_max_mb = 12000

A cache size of about 12 GB is appropriate when you use an object store instead of local disk for data storage. For details, see the [configuration](../configuration.md) guide.

Create a systemd service `/etc/systemd/system/infumap-web.service`:

    sudoedit /etc/systemd/system/infumap-web.service

with:

    [Unit]
    Description=Infumap Web Server
    Wants=network-online.target
    After=network-online.target
    RequiresMountsFor=/mnt/infudata

    [Service]
    Type=simple
    User=infumapd
    Group=infumapd
    ExecStart=/opt/infumap/bin/infumap web --settings /mnt/infudata/settings.toml
    StandardOutput=append:/var/log/infumap/infumap.log
    StandardError=append:/var/log/infumap/infumap.log
    Restart=on-failure
    RestartSec=3

    [Install]
    WantedBy=multi-user.target

Create the dedicated Infumap log file and rotation policy:

    sudo install -d -m 0755 /var/log/infumap
    sudo touch /var/log/infumap/infumap.log
    sudo chown root:root /var/log/infumap/infumap.log
    sudo chmod 0640 /var/log/infumap/infumap.log

    sudoedit /etc/logrotate.d/infumap

with:

    /var/log/infumap/infumap.log {
        daily
        rotate 60
        size 20M
        compress
        delaycompress
        missingok
        notifempty
        copytruncate
    }

Optional dry-run check:

    sudo logrotate -d /etc/logrotate.d/infumap

Enable and start the service:

    sudo systemctl daemon-reload
    sudo systemctl enable infumap-web
    sudo systemctl start infumap-web
    sudo systemctl status infumap-web

Create `~/deploy-infumap.sh`:

    cat > ~/deploy-infumap.sh <<'EOF'
    #!/usr/bin/env bash
    set -euo pipefail
    cd "$HOME/git/infumap"
    ./build.sh --no-minify
    sudo install -m 0755 "$HOME/git/infumap/infumap/target/release/infumap" /opt/infumap/bin/infumap
    sudo chown root:root /opt/infumap/bin/infumap
    sudo systemctl restart infumap-web
    sudo systemctl --no-pager --full status infumap-web
    EOF

    chmod 700 ~/deploy-infumap.sh

Run deploys with:

    ~/deploy-infumap.sh

Watch live logs:

    sudo tail -f /var/log/infumap/infumap.log

Check recent service lifecycle events (start/restart/crash):

    sudo journalctl -u infumap-web -n 100 --no-pager

Confirm it is running under the unprivileged `infumapd` user:

    pgrep -a -u infumapd infumap


### Install Prometheus and Scrape Infumap Metrics

Enable Infumap's Prometheus endpoint in `/mnt/infudata/settings.toml`:

    enable_prometheus_metrics = true
    prometheus_address = "127.0.0.1"
    prometheus_port = 9091

Use `9091` for Infumap metrics so it does not conflict with Prometheus's own default port (`9090`).

Restart Infumap so the metrics listener comes up:

    sudo systemctl restart infumap-web

Verify that Infumap metrics are available locally:

    curl -s http://127.0.0.1:9091/metrics | head

Install Prometheus on the Raspberry Pi:

    sudo apt update
    sudo apt install -y prometheus

Create a TSDB directory for Prometheus on the encrypted volume:

    sudo mkdir -p /mnt/infudata/prometheus
    sudo chown prometheus:prometheus /mnt/infudata/prometheus
    sudo chmod 750 /mnt/infudata/prometheus

Add an Infumap scrape job in `/etc/prometheus/prometheus.yml` under `scrape_configs`:

    sudoedit /etc/prometheus/prometheus.yml

    - job_name: 'infumap'
      static_configs:
        - targets: ['127.0.0.1:9091']

Validate the Prometheus config:

    sudo promtool check config /etc/prometheus/prometheus.yml

Store Prometheus data on the encrypted volume and limit disk usage by adding TSDB flags to the service arguments:

    sudoedit /etc/default/prometheus

Append these flags to `ARGS`:

    --storage.tsdb.path=/mnt/infudata/prometheus --storage.tsdb.retention.time=7d --storage.tsdb.retention.size=1GB --storage.tsdb.wal-compression

`retention.time` and `retention.size` are both enforced; Prometheus keeps data only while both limits are satisfied.
Adjust `7d` and `1GB` based on your disk budget and required history depth.
`storage.tsdb.path` keeps Prometheus blocks and WAL files on the encrypted volume instead of the default `/var/lib/prometheus`.

Prevent Prometheus from starting before `/mnt/infudata` is mounted, otherwise it may recreate the TSDB path on the unencrypted root filesystem after reboot:

    sudo install -d -m 755 /etc/systemd/system/prometheus.service.d
    sudoedit /etc/systemd/system/prometheus.service.d/infudata.conf

    [Unit]
    RequiresMountsFor=/mnt/infudata
    ConditionPathIsMountPoint=/mnt/infudata

Start Prometheus:

    sudo systemctl daemon-reload
    sudo systemctl enable prometheus
    sudo systemctl restart prometheus
    sudo systemctl status prometheus

Check that Prometheus can scrape Infumap:

    curl -s http://127.0.0.1:9090/api/v1/targets | grep -E 'infumap|health'


### Install Grafana and Connect It to Prometheus

Install Grafana from [Grafana Labs' official APT repository](https://apt.grafana.com/):

    sudo apt update
    sudo apt install -y ca-certificates gnupg wget
    wget -O /tmp/grafana.gpg.key https://apt.grafana.com/gpg.key
    gpg --show-keys --fingerprint /tmp/grafana.gpg.key

Verify that the downloaded key shows the Grafana Labs fingerprint published at `https://apt.grafana.com`:

    B53AE77BADB630A683046005963FA27710458545

Then install the key and repository, update APT metadata, and install Grafana:

    sudo install -d -m 0755 /etc/apt/keyrings
    gpg --dearmor < /tmp/grafana.gpg.key | sudo tee /etc/apt/keyrings/grafana.gpg > /dev/null
    echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list > /dev/null
    rm /tmp/grafana.gpg.key
    sudo apt update
    sudo apt install -y grafana

Bind Grafana to localhost only (do not expose port `3000` directly):

    sudoedit /etc/grafana/grafana.ini

Set:

    [server]
    http_addr = 127.0.0.1
    http_port = 3000

Optional but recommended:

    [users]
    allow_sign_up = false

Start Grafana:

    sudo systemctl enable grafana-server
    sudo systemctl restart grafana-server
    sudo systemctl status grafana-server

Verify local Grafana reachability:

    curl -I http://127.0.0.1:3000/login

Sign in to Grafana and add Prometheus as a data source:

- URL: `http://127.0.0.1:9090`
- Access: `Server` (default)

Domain exposure for Grafana is profile-specific:

- Public internet profile: see [Raspberry Pi / VPN + Public Internet](raspberry-pi-public-internet.md).
- VPN-only profile: see [Raspberry Pi / VPN-Only HTTPS (Caddy Internal CA)](raspberry-pi-vpn-only.md).


### Periodic Admin Maintenance

Apply operating system security updates and run a basic health check on a regular schedule (monthly is a good default).

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

    sudo cryptsetup luksOpen /home/infumap/enc_volume.img infuvol
    sudo mount /dev/mapper/infuvol /mnt/infudata
    sudo systemctl restart infumap-web prometheus

You will be prompted for the LUKS passphrase. This manual step is intentional: automating unlock reduces protection against physical device access.

After updates or reboots, verify service health.

On Raspberry Pi:

    sudo systemctl is-active wg-quick@wg0
    sudo systemctl is-active wg-monitor.service
    sudo systemctl is-active caddy
    sudo systemctl is-active infumap-web
    pgrep -a -u infumapd infumap
    sudo wg show wg0
    sudo tail -n 100 /var/log/wg-monitor.log

On VPS:

    sudo systemctl is-active wg-quick@wg0
    sudo wg show wg0

Check storage usage:

    df -h
    sudo du -sh /var/log/infumap
    sudo journalctl --disk-usage


### Choose a deployment profile

At this point, the shared baseline setup is complete. Continue with one of the profile guides:

- [Public internet-facing deployment](raspberry-pi-public-internet.md)
- [VPN-only deployment with HTTPS (Caddy internal CA)](raspberry-pi-vpn-only.md)
