## Raspberry Pi / VPN (Common Setup)

Running Infumap on a typical VPS means trusting the hosting provider. A sufficiently privileged operator may be able to
access your VM’s disk and, in some cases, its memory. If this risk is unacceptable, you can host Infumap on hardware
you physically control, such as a Raspberry Pi 5 on your home network. The main challenge is connectivity: most ISPs
assign dynamic public IP addresses, and home networks are usually behind NAT. To make your Raspberry Pi reachable from
the internet, route traffic securely through a host with a stable public IP address.

There are several ways to do this. A Cloudflare Zero Trust Tunnel is one convenient option, though it requires
running the `cloudflared` daemon and trusting Cloudflare’s infrastructure. A more secure approach is to establish
a WireGuard VPN between a low-cost VPS and your Raspberry Pi, forwarding HTTPS traffic unmodified through the VPS’s
public IP. This document outlines the latter approach.


### Initial Raspberry Pi Setup

Use the Raspberry Pi Imager to install a clean OS image.

- Select `Raspberry Pi OS Lite (64-bit)` (in Imager this is under `Raspberry Pi OS (other)`).
- Enable the SSH service and use public-key authentication as this is more secure than password authentication.
- Turn off telemetry.

After first boot, find the Raspberry Pi's LAN IP address by checking your router's DHCP client/lease table (sometimes
called the LAN hosts page) in the router admin interface. Then:

    ssh pi@<ip address>

Install prerequisites:

    sudo apt update
    sudo apt upgrade
    sudo apt install tmux ufw wireguard

(optional) Disable additional services commonly unnecessary for a headless Infumap host:

    sudo systemctl disable --now avahi-daemon.service avahi-daemon.socket 2>/dev/null || true
    sudo systemctl disable --now triggerhappy.service 2>/dev/null || true
    sudo systemctl disable --now ModemManager.service 2>/dev/null || true
    sudo systemctl disable --now cups.service cups-browsed.service 2>/dev/null || true

(optional, if installed) Disable and remove Raspberry Pi Connect (cloud remote access):

    sudo systemctl disable --now rpi-connect.service 2>/dev/null || true
    sudo apt purge -y rpi-connect || true
    sudo apt purge -y rpi-connect-lite || true
    sudo apt autoremove -y

(optional) Configure `journald` for RAM-only logs. This keeps diagnostics available for live troubleshooting
while avoiding persistent log growth on disk:

    # in /etc/systemd/journald.conf
    Storage=volatile
    RuntimeMaxUse=4M
    Compress=yes

Then restart and verify:

    sudo systemctl restart systemd-journald
    journalctl --disk-usage

Recovery note: for severe or unclear failures, rebuild the Pi and restore from backup.

(optional, Ethernet-only and no audio use) Reduce hardware/software attack surface by adding the following to `/boot/firmware/config.txt`:

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

Note: This assumes you will be setting up your WireGuard network interface on 10.0.0.0/24. If this clashes with your router,
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

After setting up the firewall, build Infumap from source.

First install Rust:

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

Now clone the Infumap repo:

    cd ~
    mkdir git
    cd git
    git clone https://github.com/infumap/infumap.git
    cd infumap
    git checkout v0.3.0

Find the latest `nvm` release at https://github.com/nvm-sh/nvm (for example `v0.40.1`) and install similarly:

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    nvm install node

Finally build Infumap:

    ./build.sh

And copy to somewhere on the current `PATH`:

    sudo cp ~/git/infumap/infumap/target/release/infumap /usr/local/bin/


### Initial VPS Setup

Create a VPS running Debian 13 x64 using your vendor of choice. Select a region as physically close to your Raspberry
Pi device as possible. A cheap/small instance size will suffice since we will not use the VPS instance for anything
other than forwarding HTTPS web traffic.

Install required packages:

    sudo apt update
    sudo apt upgrade -y
    sudo apt install --no-install-recommends wireguard-tools nftables ufw

(optional) If prompted, use `sudo apt autoremove` to remove any packages marked as no longer required.

Configure and enable the VPS firewall:

    sudo ufw --force reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw default deny routed
    sudo ufw allow 22/tcp
    sudo ufw allow 51820/udp
    sudo ufw --force enable
    sudo ufw status verbose

Keep `sudo ufw default deny routed` as the secure default baseline. If you later choose the public internet-facing profile,
add explicit routed allow rules only for forwarded `80/443` traffic to `10.0.0.2` in that profile guide.

(optional) Add disk-usage limits on logs/core dumps to conserve disk space:

Note: This is mainly for operators using spare VPS capacity for additional non-core tasks. If you do this, be sure to
review the security impact of every extra service you install and run.

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
    journalctl --disk-usage

Remove old persistent journal files created before `Storage=volatile`:

    sudo rm -rf /var/log/journal
    sudo systemctl restart systemd-journald
    journalctl --disk-usage

(optional, if installed) Disable `rsyslog` to avoid duplicate on-disk log streams:

    sudo systemctl disable --now rsyslog.service 2>/dev/null || true

On your admin machine, generate a new dedicated SSH keypair for this VPS (run locally, not on the VPS):

    ssh-keygen -t ed25519 -a 100 -f ~/.ssh/infumap_vps_ed25519 -C "infumap-vps"

Display the public key so you can copy it:

    cat ~/.ssh/infumap_vps_ed25519.pub

You will paste this value as `YOUR_ADMIN_PUBLIC_KEY` in the user setup step below.

Using a new key here lowers risk from leaked bootstrap credentials or provider account compromise, although it does not
remove the need to trust the VPS provider.

Create a non-root admin user for ongoing administration:

    sudo adduser --gecos "" infumap
    sudo usermod -aG sudo infumap
    sudo install -d -m 700 -o infumap -g infumap /home/infumap/.ssh
    echo "{YOUR_ADMIN_PUBLIC_KEY}" | sudo tee /home/infumap/.ssh/authorized_keys > /dev/null
    sudo chown infumap:infumap /home/infumap/.ssh/authorized_keys
    sudo chmod 600 /home/infumap/.ssh/authorized_keys

Where `YOUR_ADMIN_PUBLIC_KEY` is a full public key line from your admin machine (for example: `ssh-ed25519 AAAA... you@laptop`).

Set a strong password for `infumap` when prompted. This password is for `sudo` and console recovery; SSH password
authentication is disabled later.

Verify login in a new terminal before continuing:

    ssh -i ~/.ssh/infumap_vps_ed25519 infumap@{YOUR_SERVER_INTERNET_IP}
    sudo -v

After confirming `infumap` works, remove provider bootstrap root credentials:

    sudo truncate -s 0 /root/.ssh/authorized_keys
    sudo passwd -l root

We will use WireGuard to create a secure, persistent, reliable network between our VPS instance and Raspberry Pi.

Generate the VPS WireGuard keys:

    sudo install -d -m 700 /etc/wireguard/keys
    wg genkey | sudo tee /etc/wireguard/keys/server.key | wg pubkey | sudo tee /etc/wireguard/keys/server.key.pub > /dev/null

Create the WireGuard config file:

    sudoedit /etc/wireguard/wg0.conf

    [Interface]
    Address = 10.0.0.1/32
    ListenPort = 51820
    PrivateKey = {contents of /etc/wireguard/keys/server.key}
    SaveConfig = false

Lock down the permissions of the server keys and config:

    sudo chmod 600 /etc/wireguard/wg0.conf /etc/wireguard/keys/server.key
    sudo chmod 644 /etc/wireguard/keys/server.key.pub

After confirming `infumap` login works, lock down SSH:
    
    sudoedit /etc/ssh/sshd_config
  
and set:

    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitRootLogin no
    X11Forwarding no
    UsePAM yes

Also check for config files in `/etc/ssh/sshd_config.d` that may override `/etc/ssh/sshd_config` and update if required.

If present, keep `AcceptEnv LANG LC_* COLORTERM NO_COLOR` so locale/color environment variables can pass through SSH.
Also keep the existing `Subsystem sftp ...` entry so `scp` continues to work.

Validate and reload SSH server:

    sudo sshd -t
    sudo systemctl reload ssh

### Raspberry Pi WireGuard Setup

Install WireGuard:

    sudo apt update
    sudo apt install -y openresolv net-tools wireguard

Generate WireGuard keys for your Raspberry Pi instance:

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

    sudoedit /etc/wireguard/wg0.conf

    [Interface]
    Address = 10.0.0.1/32
    ListenPort = 51820
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


### Setup a macOS WireGuard Admin Client (Full VPN Access)

Set up your admin Mac laptop to join the same WireGuard VPN and reach all VPN peers (for example `10.0.0.1` VPS and
`10.0.0.2` Raspberry Pi).
The same model also works for other WireGuard client platforms (Windows, Linux, iOS, Android), but only macOS is documented here.

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
    Endpoint = {YOUR_SERVER_INTERNET_IP}:51820
    PersistentKeepalive = 25

Now add the Mac as a peer on the VPS (`/etc/wireguard/wg0.conf`):

    [Peer]
    PublicKey = {YOUR_MAC_PUBLIC_KEY}
    AllowedIPs = 10.0.0.10/32

Restart WireGuard on the VPS:

    sudo systemctl restart wg-quick@wg0

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
    ssh pi@10.0.0.2

If `10.0.0.1` works but `10.0.0.2` does not, confirm these routed allow rules are present and that the source IP matches
your admin client tunnel IP.


### Set Up a WireGuard Monitoring Service

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


### Set Up an Encrypted Drive

Create an encrypted volume on your Raspberry Pi to ensure that even if an attacker gains physical access to it,
they cannot read your Infumap instance data.

On your Raspberry Pi:

    sudo apt-get install cryptsetup

Check available bytes:

    df -k

The Raspberry Pi 5 kit comes with a 32 GB flash drive. If you are using this, a 16 GB encrypted volume is appropriate.
In `/home/pi`, create this file with random data:

    sudo dd if=/dev/urandom of=/home/pi/enc_volume.img bs=1M count=16384 status=progress

Format this file as a LUKS container:

    sudo cryptsetup luksFormat /home/pi/enc_volume.img

Open the container:

    sudo cryptsetup luksOpen /home/pi/enc_volume.img infuvol

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
Include this in your periodic maintenance runbook.


### Configure and Run Infumap

The easiest way to create a default settings file is to simply run infumap:

    infumap web
    Ctrl-C

The settings file will be created in `~/.infumap`. Move this into the encrypted drive:

    sudo mv ~/.infumap/. /mnt/infudata/

Update [settings.toml](../configuration.md) as desired. At a minimum, update the data and cache dirs and max cache size:

    data_dir = "/mnt/infudata/data"
    cache_dir = "/mnt/infudata/cache"
    cache_max_mb = 12000

A cache size of about 12 GB is appropriate if you use an object store, rather than local disk for data storage. For more
information, refer to the [configuration](../configuration.md) guide.

Since the encrypted drive used by Infumap needs to be manually mounted on reboot, there is little benefit to creating a
service to manage Infumap. I just run it in a `tmux` session.

Start a new `tmux` session:

    tmux

Run Infumap:

    infumap web --settings /mnt/infudata/settings.toml

Key tmux commands to be aware of:

    Ctrl-b then s (list sessions)
    Ctrl-b then d (detach)
    Ctrl-b then a (attach)


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

    sudo cryptsetup luksOpen /home/pi/enc_volume.img infuvol
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


### Choose a deployment profile

At this point, the shared baseline setup is complete. Continue with one of the profile guides:

- [Public internet-facing deployment](raspberry-pi-public-internet.md)
- [VPN-only deployment with HTTPS (local CA)](raspberry-pi-vpn-only.md)
