
## Raspberry Pi / VPN

If you run Infumap on hardware managed by someone else (e.g. Amazon EC2, Digital Ocean Droplet etc.), you have no option but to trust them.
Notably, it is theoretically possible for your hosting provider to take a snapshot of your running VPS instance, including any data currently
in memory. There is no way to secure Infumap against this possibility.

If this risk is unacceptable to you, your only option is to host Infumap on hardware that you control. A Raspberry Pi 5 connected to your
home router is a good low-cost option for doing this. Unfortunately, most Internet service providers (ISPs) dynamically issue WLAN IPs from
a private subnet. Consequently, in order to access your Raspberry Pi device from the internet, you will need to securely route traffic via
a public IP address.

There are many ways of setting this up. A Cloudflare Zero Trust Tunnel is one easy option, though you need to consider the security implications
of running their daemon `cloudflared`. Another option is to set up a wireguard VPN between a low cost VPS and your Raspberry Pi and tunnel HTTPS
traffic through the public IP of the VPS. This is the approach outlined in this document, and how I run my personal Infumap instance.

In terms of performance / latency, I find it notably better than hosting on a 2 vCPU, 4 GB
[high performance Vultr VPS instance](https://www.vultr.com/pricing/#cloud-compute) @ $24 / mo, despite the additional network hops.
This is what I was doing previously.


### Initial Raspberry Pi Setup

Use the Raspberry Pi Imager to install a clean OS image.

- Select Raspberry Pi OS (64 bit).
- Enable the SSH service and use public-key authentication as this is more secure than password authentication.
- Turn off telemetry.

To figure out the IP address of your Raspberry Pi you can typically log into your router admin webpage and inspect the LAN host information page.

    ssh pi@<ip address>

(optional) Disable some irrelevant services to conserve resources:

    sudo systemctl disable --global pipewire
    sudo systemctl disable --global pulseaudio
    sudo systemctl disable --global pipewire-pulse

(optional) Update `/etc/systemd/journald.conf` to limit the disk space used by `journalctl`:

    SystemMaxUse=500M          # Maximum disk space for persistent logs
    SystemKeepFree=10%         # Minimum free disk space to maintain
    SystemMaxFileSize=100M     # Maximum size of individual journal files
    Compress=yes               # Enable compression

(optional) Disable bluetooth and wifi (only if you are using `eth0` for networking obviously) by adding the following to `/boot/firmware/config.txt`:

    dtoverlay=disable-bt
    dtoverlay=disable-wifi

Install prerequisites:

    sudo apt update
    sudo apt upgrade
    sudo apt install tmux ufw wireguard

Setup firewall:

    sudo ufw reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22
    sudo ufw allow from 10.0.0.0/24 to any port 443 proto tcp
    sudo ufw enable

Note: This assumes you will be setting up your wireguard network interface on 10.0.0.0/24. If this clashes with your router,
or some other local network configuration, you will need to change it to something that doesn't.

For additional security, you might consider restricting ssh port access to devices on your local router subnet, making
`sshd` inaccessible from the internet. To do this, use the following rule for port 22 instead:

    sudo ufw allow from YOUR_LOCAL_SUBNET to any port 22 proto tcp

Where YOUR_LOCAL_SUBNET is your local subnet in CIDR notation, as determined by your router configuration - e.g. 192.168.0.0/16

The tradeoff of course is that there is now no way for you to access your Infumap installation without being physically
present in your home. The main implication of this comes if you decide to use an encrypted volume to store your infumap data
(which is highly recommended). In the event of a power outage, you will need to manually enter your password to re-mount the
encrypted volume. If you have locked down ssh access, you won't be able to do this remotely.

Your predicament is not as bad as it first seems though - if you have Infumap backups configured (which you should), you can use the
`infumap emergency` command to quickly pull backup information locally and start up a temporary instance - you won't be
locked out of access to your information.

After setting up the firewall, build infumap from source.

First install rust:

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

Now clone the infumap repo:

    cd ~
    mkdir git
    cd git
    git clone https://github.com/infumap/infumap.git

TODO: At the time of writing, there are no releases. When there are, check out the latest release before building. Do not use a
master branch build in production as it will be much less well tested.

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
through HTTPS web requests to the Raspberry Pi device.

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
    Address = 10.0.0.1/24
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
    Address = 10.0.0.1/24
    ListenPort = 51820
    PrivateKey = {YOUR_SERVER_PRIVATE_KEY}
    SaveConfig = false

    [Peer]
    PublicKey = {YOUR_CLIENT_PUBLIC_KEY}
    AllowedIPs = 10.0.0.2/24

Automatically bring up the `wg0` VPN interface on boot:

    systemctl enable wg-quick@wg0

And start `wg0` now:

    systemctl start wg-quick@wg0

Verify it's up:

    wg show wg0


### Setup A WireGuard Monitoring Service

With the above setup, I observe a periodic issue whereby the Raspberry Pi device becomes unreachable over
the WireGuard network. I have not identified the exact cause, though I suspect it is likely due to my ISP
changing the WLAN or public IP address. In order to work around this issue, I use a simple script to monitor
whether the VPS server is reachable from the Raspberry Pi, and restart the WireGuard service on the Raspberry
Pi device if it is not.

Copy the `infumap/tools/wg-monitor.sh` script to `/usr/local/bin/`.

Create a file `/etc/systemd/system/wg-monitor.service` with the following text:

    [Unit]
    Description=Monitor WireGuard Service
    After=network.target

    [Service]
    Type=simple
    User=pi
    ExecStart=/usr/local/bin/wg-monitor.sh 10.0.0.1 /var/log/wg-monitor.log
    Restart=always
    RestartSec=10

    [Install]
    WantedBy=multi-user.target

Reload systemd, start, and enable. 

    sudo systemctl daemon-reload
    sudo systemctl enable wg-monitor.service
    sudo systemctl start wg-monitor.service


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

You need to manually open the LUKS container and mount the volume on every system reboot:

    sudo cryptsetup luksOpen enc_volume.img infuvol
    sudo mount /dev/mapper/infuvol /mnt/infudata

You will be prompted for a password each time you open the LUKS volume. It is possible to automate this on startup, but doing so
would defeat the purpose of using the encrypted drive as as someone with access to the physical device would be able to mount the
volume.


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
