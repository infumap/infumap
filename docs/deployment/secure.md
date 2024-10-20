
## A Security Conscious Deployment on Vultr.com

_TODO: assume these notes are incomplete / very rough / probably flawed._

Always choose a reputable cloud vendor when hosting sensitive information because you have no option but to trust them. It is possible to take a snapshot of a running VPS instance, including any data currently in memory, so you need to assume this is a possibility.

Vultr is a well established alternative to AWS / Google Cloud / Azure. I have used them for a long time due to ease of use, familiarity and cost. Before switching to a Raspberry Pi server physically located in my home, I hosted my personal Infumap instance with Vultr, and took these notes as I set it up.

These notes are relevant / may be useful even if you use another provider.


### Vultr Account

General notes:
- Make sure you have 2 factor authentication configured and enabled.
- Maintain pre-payment of funds well in advance of expected usage to guard against possible problems with credit card payments.


### Deploy A New Server Instance

  - Select "Cloud Compute".
  - Select a server type and plan. Infumap will work (and scale) adequately on the lowest tier plans. However usability improves significantly with more resources. I found that Shared CPU / High frequency / 2 VCPU / 4Gb works very well ($24/mo), and I recommend this for optimal experience.
  - Select a location close to you. https://wondernetwork.com/pings is a good resource for checking ping times.
  - Select "Debian 12", or for the extra paranoid "Upload ISO".
    - Two reasons you may want to use the Debian installation ISO directly from the Debain website rather than an image supplied by Vultr:
      - You can be more sure it is more trustworthy.
      - There won't be any unexpected non-standard configuration.
    - Paste in the URL to the latest debian net install ISO. You can find a link to that on this page: https://www.debian.org/distrib/netinst . At the time of writing, this was: https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.1.0-amd64-netinst.iso
  - Disable auto-backup (Infumap manages backups for you).
  - Disable IPv6.
  - Enter a host name to align with the domain you will use. This may include a subdomain.
  - Click deploy now.
  - Your instance will boot from the Debian installation ISO image you specified.


### Install Debian

If installing from the Debian ISO:
  - When you see the instance is running, select "view console" from the instance "..." menu.
  - If you do this quickly you will see a graphical menu with an "Install" option. If you aren't quick enough, execution will default to a text based install, which is not ideal because you can't scroll the console window. If you see this, it is best to restart the server to get the BIOS menu back.
  - Follow the prompts to install. Some specific notes:
    - Specify the same host domain name as when you created the server.
    - Use the name `infumap` for the initial user (full name and username).
    - You will be changing the passwords for both `infumap` and `root` users soon, so strong passwords are not critical at this point.
    - Use manual partitioning to remove the swap partition (potential security hole) and create one EXT4 partition. Note that disk encryption is not set up here, because the encryption key needs to be pasted into the console (both on setup and restart). This could potentially be intercepted by Vultr.
    - Configure package manager: do not scan for additional media.
    - Software selection: use spacebar to select / unselect. Select only "SSH server" and "standard system utilities". Unselect everything else.
    - Install GRUB bootloader (on /dev/vda).
    - Finish the installation: Do not select continue. Instead, go to "Settings / Custom ISO" in your Vultr instance settings and click "Remove ISO" to prevent the ISO from booting up on restart. The instance will automatically restart.
  - Select "Connect" in the Vultr console window - you should see a login prompt.



### Setup SSH

- Use the Vultr console to login using the `root` user.
- Install sudo:
  > `apt install sudo`
- Add the infumap user to the sudo group.
  > usermod -a -G sudo infumap
- Create user `login`:
  > `useradd -m login`
  > `passwd login`
  > `usermod -a -G sudo login`
- Use the following command to display the SSH ED25519 key fingerprint:
  > ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
- Login as the `login` user using SSH. You will be warned that "the authenticity of host cannot be established". To establish this, check the ssh fingerprint displayed is the same as that in the previous step.
- Type `exit` to log out of the Vultr console session. Close the console window. You should no longer access the server instance via the Vultr console. Use the SSH session from this point on.
- Change the password of the `login`, `infumap` and `root` users (these have been entered via the Vultr console and could have been intercepted):
  > passwd login
  > su
  > passwd infumap
  > passwd root
  > exit
- Create a new key/pair locally:
  > ssh-keygen -t ed25519
- Copy this to the server:
  > ssh-copy-id -i ~/.ssh/<your_key_name>.pub login@<yourhostname>
- Log into the server as the `login` user using your key.
- Disable password based login:
  > sudo vi /etc/ssh/sshd_config
  and set PasswordAuthentication to no
          UsePAM to no
          PermitRootLogin to prohibit-password -> no
- Restart SSH server
  > sudo systemctl reload ssh
- logout
- Test that you can't log in with the infumap or root user with your password.
- Add the key to the authentication agent locally:
  > ssh-add ~/.ssh/<your_key_name>
- Test that you can login using your key.


### Add block storage

- Block storage HDD is fine.
- Manage block storage, connect to your instance.
- Find the mount id. the disks is mounted on your instance here: `/dev/disk/by-id/<mount_id>`
- `sudo apt install cryptsetup`
- Roughly follow these instructions: https://www.digitalocean.com/community/tutorials/how-to-create-an-encrypted-file-system-on-a-digitalocean-block-storage-volume
- `sudo cryptsetup luksOpen /dev/disk/by-id/<mount_id> secure-volume`
- `sudo /sbin/mkfs.ext4 /dev/mapper/secure-volume`
- `sudo mkdir /mnt/secure`
- `sudo chmod a+rwx secure`
- `sudo mount /dev/mapper/secure-volume /mnt/secure`



### install firewall

https://www.digitalocean.com/community/tutorials/how-to-set-up-a-firewall-with-ufw-on-debian-11-243261243130246d443771547031794d72784e6b36656d4a326e49732e

    sudo apt install net-tools
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow ssh
    sudo ufw allow https
    sudo ufw allow to <docker_bridge_address>



### Caddy in docker using Gvisor
 - Install docker by following the instructions here: https://docs.docker.com/engine/install/debian/ or `apt install docker.io`
 - Install gvisor by following the instructions here: https://gvisor.dev/docs/user_guide/install/
 - Setup docker to use gvisor by following the instructions here: https://gvisor.dev/docs/user_guide/quick_start/docker/
   > sudo runsc install
   > sudo systemctl restart docker
 - `su`.
 - create a file `CaddyFile` in `/root`.
   > yourdomain {
   >  reverse_proxy localhost:8000
   > }
 - `sudo docker run --runtime=runsc -d -p 443:443 -v /root/Caddyfile:/etc/caddy/Caddyfile -v /mnt/secure/caddy_data:/data caddy dmesg`
 - check gvisor: `sudo docker logs <id>`
 - `sudo docker rm <id>`
 - `sudo docker run --runtime=runsc -d -p 443:443 -v /root/Caddyfile:/etc/caddy/Caddyfile -v /mnt/secure/caddy_data:/data caddy`
 - need to get out of docker using actual ip address


### Development

To serve a debug build, which has the advantage of exposing good error messages:

copy `vite.config.ts` to `vite.config.dev.ts` and update the targets in it to `<docker_bridge_address>`.

update `Caddyfile` (in root's ~) to point to port 3000, not 8000.

in a separate tmux session:

```
node ./node_modules/vite/bin/vite.js --config ./vite.config.dev.ts --host <docker_bridge_address>
```

### TODO ...



## Guarding Against Loss of Access to Your Information

Create a tar file with the following information:

- The Infumap settings.toml file which includes:
  - The object store backup encryption key. IMPORTANT! without this, the database backup data is useless.
  - Connection information and credentials for all S3 compatible object stores.
- Login credentials for your VPS provider.
  - Username / password.
  - TOTP key / QR code screen capture.
- ssh keys for logging into the VPS that hosts Infumap.
  - Allows access to user and item database logs, and objects if stored.
- Login credentials for S3 provider(s).
  - Username / password.
  - TOTP keys / QR code screen capture.
- Username / password of the infumap user.
- Email passwords - these can often be used to recover other accounts.
- Filesystem encryption key (is used).


Checks:
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
