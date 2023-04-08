# Operations

## Simple Deployment on Debian 11

```
ufw allow 443
```

Install caddy:

```
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Edit the Caddyfile in `/etc/caddy/Caddyfile`.
- change `:80` to your domain name.
- uncomment the `reverse_proxy` line.
- comment out the `root` line.

Then reload:

```
systemctl reload caddy
```


## Guarding Against Loss of Access to Your Information

Create a tar file with the following information:

- The Infumap settings.toml file which includes:
  - The object store backup encryption key. IMPORTANT! without this, the database backup data is useless.
  - Connection information and credentials for all S3 compatible object stores.
- A separate text file with the backup encryption key (because this is so important!).
- Login credentials for your VPS provider.
  - Username / password.
  - TOTP key / QR code screen capture.
- ssh keys for logging into the VPS that hosts Infumap.
  - Allows access to user and item database logs, and objects if stored.
  - Consider copying your entire .ssh folder to guard against accidentally copying the wrong key.
- Login credentials for S3 provider(s).
  - Username / password.
  - TOTP keys / QR code screen capture.
- Username / password of the infumap user.
- Email passwords - these can often be used to recover other accounts.
- 

Double check:
- Download a backup and ensure you can extract it using the backup key.
- Ensure you copied the correct ssh key for logging into your VPS.


This should be everything you need for disaster recovery. Encrypt the file:

```
openssl enc -e -aes256 -in disaster_recovery.tar -out recovery.aes256
```

(this will prompt for a password)

This can be decrypted with:

```
openssl enc -d -aes256 -in recovery.aes256 | tar xv
```

Email this to yourself disaster_recovery.aes256 along with these instructions. Also give disaster_recovery.aes256 to a 3rd party. Also put it on physical media that you keep in geographically separated locations.

If possible, prepay for hosting / object store services, and keep the prepaid balances high. Use different credit cards for different providers so if there is a problem with one which ultimately results in loss of data, there is redundancy.

Periodically sync data in remote objects store(s) locally.

## Metrics

(TODO).
