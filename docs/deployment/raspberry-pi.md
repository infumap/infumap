
## Raspberry Pi / VPN

_TODO: these notes are incomplete / very rough / probably flawed._

Use the Raspberry Pi Imager to install a new image.

Remember to:
- Enable the SSH service.
- Turn off telemetry.

Figure out the IP address of your Raspberry Pi. I did this by logging into my router admin page and looking at the LAN host information page.

    ssh infumap@<ip address>

Install things:

    sudo apt update
    sudo apt install emacs tmux ufw

Setup firewall:

    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22
    sudo ufw allow 443
    sudo ufw enable

Build infumap (there is no release yet):

Also, building from source downloaded directly from github gives extra confidence the binary isn't compromised.

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

    cd ~
    mkdir git
    cd git
    git clone https://github.com/infumap/infumap.git

Determine the latest version of `nvm` here https://github.com/nvm-sh/nvm (at the time of writing 0.39.7) and install similar to:

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    nvm install node

    ./build.sh
    mv ./infumap/target/release/infumap ~
    tmux
    ./infumap web


set up a wireguard server ( https://serversideup.net/how-to-set-up-wireguard-vpn-server-on-ubuntu-20-04/ ):

```
apt install wireguard

sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/server.key | wg pubkey | sudo tee /etc/wireguard/keys/server.key.pub

ip -o -4 route show to default | awk '{print $5}'

emacs /etc/wireguard/wg0.conf

[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = YOUR_SERVER_PRIVATE_KEY
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
SaveConfig = true
```


```
sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/client.key | wg pubkey | sudo tee /etc/wireguard/keys/client.key.pub
```


## Install wiregard client on Ubuntu

Install wireguard:

```
apt update
apt install openresolv net-tools wireguard
```

Create a public/private key pair:

```
sudo mkdir -p /etc/wireguard/keys; wg genkey | sudo tee /etc/wireguard/keys/client.key | wg pubkey | sudo tee /etc/wireguard/keys/client.key.pub
```

Create the wg0 interface config:

```
emacs /etc/wireguard/wg0.conf
```

```
[Interface]
PrivateKey = YOUR_CLIENT_PRIVATE_KEY
Address = YOUR_CLIENT_VPN_IP/32

[Peer]
PublicKey = YOUR_SERVER_PUBLIC_KEY
AllowedIPs = 10.0.0.0/24
Endpoint = YOUR_SERVER_INTERNET_IP:51820
PersistentKeepalive = 25
```

Where YOUR_CLIENT_VPN_IP is a unique ip for your client, e.g. 10.0.0.2

`PersistentKeepalive = 25` should only be specified for the Raspberry Pi.

Bring up the interface, and enable it over system restarts:

```
sudo wg-quick up wg0

sudo systemctl enable wg-quick@wg0
```

```
sudo wg set wg0 peer YOUR_CLIENT_PUBLIC_KEY allowed-ips YOUR_CLIENT_VPN_IP
```

```
wg show
wg-quick down wg0 # saves current state to .conf
```

references:

https://www.wireguard.com/papers/wireguard.pdf#page7
https://gist.github.com/chrisswanda/88ade75fc463dcf964c6411d1e9b20f4
https://serversideup.net/how-to-configure-a-wireguard-macos-client/
https://serversideup.net/how-to-set-up-wireguard-vpn-server-on-ubuntu-20-04/
https://dnsleaktest.com

### TODO:

https / DNS on private network.
