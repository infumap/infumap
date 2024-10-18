
## Raspberry Pi / VPN

_TODO: these notes are incomplete / very rough / probably flawed._

If you run Infumap on hardware managed by someone else (Amazon EC2, Digital Ocean Droplet etc.), you have no option but to trust them. In particular, it is possible for your hosting provider to take a snapshot of any running VPS instance, including any data currently in memory. There is no way to secure Infumap against this.

If trusting your VPS vendo is unacceptable to you, your only option is to host Infumap on hardware that you control. I personally host Infumap on a Raspberry Pi 5 sitting in my living room. I'm very happy with this setup.

Unfortunately, most Internet service providers (ISPs) dynamically issue WAN IPs from a private subnet. In order to access Infumap from the internet, you will need to securely route traffic via a public IP address that you control.

This document walks through one method of setting all of this up.

### Raspberry Pi Setup

Use the Raspberry Pi Imager to install a new image.

- Choose the Raspberry Pi OS (64 bit) image.
- Enable the SSH service and use public-key authentication as this is more secure than password authentication.
- Turn off telemetry.

To figure out the IP address of your Raspberry Pi you can typically log into your router admin webpage and inspect the LAN host information page.

    ssh pi@<ip address>

Install prerequisites:

    sudo apt update
    sudo apt install emacs tmux ufw wireguard

Setup firewall:

    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22
    sudo ufw allow 443
    sudo ufw enable

TODO: disable SSH access via VPN subnet.

Build infumap from source.

First install rust:

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

Now clone the infumap repo:

    cd ~
    mkdir git
    cd git
    git clone https://github.com/infumap/infumap.git

Determine the latest version of `nvm` here https://github.com/nvm-sh/nvm (at the time of writing 0.39.7) and install similar to:

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    nvm install node

Finally build Infumap:

    ./build.sh
    mv ./infumap/target/release/infumap ~
    tmux
    ./infumap web


### Setup Wireguard on VPS

Install prerequisites:

    apt update && sudo apt upgrade
    apt install wireguard

Generate the VPS wireguard keys:

    sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/server.key | wg pubkey > /etc/wireguard/keys/server.key.pub

Determine the default network interface for internet traffic:

    ip -o -4 route show to default | awk '{print $5}'

Create the wireguard config file:

    emacs /etc/wireguard/wg0.conf

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

    sudo emacs /etc/wireguard/wg0.conf

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

    emacs /etc/wireguard/wg0.conf

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



### Useful References:

https://www.wireguard.com/papers/wireguard.pdf#page7
https://gist.github.com/chrisswanda/88ade75fc463dcf964c6411d1e9b20f4
https://serversideup.net/how-to-configure-a-wireguard-macos-client/
https://serversideup.net/how-to-set-up-wireguard-vpn-server-on-ubuntu-20-04/
https://dnsleaktest.com


### TODO:

https / DNS on private network.
