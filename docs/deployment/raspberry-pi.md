
## Raspberry Pi / VPN

_TODO: these notes are incomplete / very rough / probably flawed._

If you run Infumap on hardware managed by someone else (e.g. Amazon EC2, Digital Ocean Droplet etc.), you have no option but to trust them. Notably, it is possible for your hosting provider to take a snapshot of any running VPS instance, including any data currently in memory. There is no way to secure Infumap against this.

If trusting your VPS vendor is unacceptable to you, your only option is to host Infumap on hardware that you control. I personally host Infumap on a Raspberry Pi 5 sitting in my living room. I'm very happy with this setup.

Most Internet service providers (ISPs) dynamically issue WAN IPs from a private subnet. Consequently, in order to access Infumap from the internet, you will need to securely route traffic via a public IP address that you control.

This document walks through one method of setting all of this up.


### Initial Raspberry Pi Setup

Use the Raspberry Pi Imager to install a new image.

- Choose the Raspberry Pi OS (64 bit) image.
- Enable the SSH service and use public-key authentication as this is more secure than password authentication.
- Turn off telemetry.

To figure out the IP address of your Raspberry Pi you can typically log into your router admin webpage and inspect the LAN host information page.

    ssh pi@<ip address>

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
    sudo ufw start
    sudo ufw enable

Note: This assumes you will be setting up your wiregard network interface on 10.0.0.0/24. If this clashes with your router,
or some other local network configuration, you will need to change accordingly.

For additional security, you might consider restricting ssh port access to devices on your local router subnet, making
`sshd` inaccessible from the internet. To do this, use the following rule for port 22 instead:

    sudo ufw allow from YOUR_LOCAL_SUBNET to any port 22 proto tcp

Where YOUR_LOCAL_SUBNET is your local subnet in CIDR notation, as determined by your router configuration - e.g. 192.168.0.0/16

The tradeoff of course is that there is now no way for you to access your own Infumap installation without being physically
present in your home. The main implication of this comes if you decide to use an encrypted volume to store your infumap data
(which is highly recommended). In the event of a power outage, you will need to manually enter your password to re-mount the
encrypted volume. If you have locked down ssh access, you won't be able to do this remotely.

Your predicament is not as bad as it first seems though - if you have backups enabled (which you should), you can use the
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

Determine the latest version of `nvm` here https://github.com/nvm-sh/nvm (at the time of writing 0.39.7) and install similar to:

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    nvm install node

Finally build Infumap:

    ./build.sh

And copy to somewhere on the current `PATH`:

    sudo cp ~/git/infumap/infumap/target/release/infumap /usr/local/bin/


### Initial VPS Setup

Create a VPS running Debian 12 using your vendor of choice.

The smallest instance size will suffice, since we will not use the VPS instance for anything other than forwarding
through https web requests to the Raspberry Pi device.

Note: I actually use this VPS instance to host a number of custom made data services (that I don't make public) which
expose information via the infumap protocol. I link out to these from my main Infumap 

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


### Setup Wireguard on Raspberry Pi

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


### Add Wireguard Peer on VPS

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

Automatically bring up the wg0 VPN interface on boot:

    systemctl enable wg-quick@wg0

Start wg0 up now:

    systemctl start wg-quick@wg0

Verify it's up:

    wg show wg0

### Install caddy on Raspberry Pi

    sudo apt install caddy

Contents of `/etc/caddy/Caddyfile`:

    {
        log {
            output file /var/log/caddy/access.log
            format json
        }
    }

    YOUR_DOMAINNAME {
        reverse_proxy 127.0.0.1:8000
    }

Start:

    systemctl enable caddy
    systemctl start caddy

### Expose Infumap on VPS

Enable IP forwarding on your server to allow it to route packets between interfaces

edit `/etc/sysctl.conf` and uncomment the line:

    net.ipv4.ip_forward=1

then

    sysctl -p

nftables config :

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

Enable:

    systemctl enable nftables
    systemctl start nftables


### Encrypted drive

On Rasperry Pi:

    sudo apt-get install cryptsetup

Available bytes:

    df -k

In `/root`, create a 16Gb file with random data:

    dd if=/dev/urandom of=enc_volume.img bs=1M count=16384 status=progress

Format as a LUKS container:

    sudo cryptsetup luksFormat enc_volume.img

Open the container:

    sudo cryptsetup luksOpen enc_volume.img infuvol

Create filesystem:

    sudo mkfs.ext4 /dev/mapper/infuvol

Create a mount point:

    sudo mkdir /mnt/infudata

mount:

    sudo mount /dev/mapper/infuvol /mnt/infudata

Can unmount and close the LUKS container with:

    sudo umount /mnt/infudata
    sudo cryptsetup luksClose infuvol

### Configure and run Infumap:

The easiest way to create a default settings file is to simply run infumap:

    infumap web
    Ctrl-C

Move the created files into the encrypted drive:

    sudo mv ~/.infumap/* /mnt/infudata

Update [settings.toml](../configuration.md) as desired. At a minimum, update the data and cache dirs:

    data_dir = "/mnt/infudata/data"
    cache_dir = "/mnt/infudata/cache"

Start a tmux session to run infumap in:

    tmux

Run infumap:

    infumap web --settings /mnt/infudata/settings.toml

Key tmux commands to know:

    Ctrl-b-s (list sessions)
    Ctrl-b-d (detatch)
    Ctrl-b-a (attach)

### Test Network interruption

From raspberry pi instance:

    curl -4 ifconfig.me

To get public IP of home network. Get WLAN IP from router.

Remove power from Raspberry Pi and Router for some time.

Turn back on, and see if everything recovers.

Will need to manually re-mount secure drive on Raspberry Pi.


### Additional Security

Configure the firewall to disallow ssh access from the wireguard network. 

Run caddy on a different Raspberry Pi instance. 

### Infumap data sources

Use unused resources on VPS for running infumap data sources.

### Useful References:

https://www.wireguard.com/papers/wireguard.pdf#page7
https://gist.github.com/chrisswanda/88ade75fc463dcf964c6411d1e9b20f4
https://serversideup.net/how-to-configure-a-wireguard-macos-client/
https://serversideup.net/how-to-set-up-wireguard-vpn-server-on-ubuntu-20-04/
https://dnsleaktest.com


### TODO:

https / DNS on private network.

how does wireguard behave when the ISP changes your public IP or WAN address?

note current public ip using:
    curl -4 ifconfig.me
and wan address using 

Determine the default network interface for internet traffic:

    ip -o -4 route show to default | awk '{print $5}'

sdf

    mv ./infumap/target/release/infumap ~
    tmux
    ./infumap web