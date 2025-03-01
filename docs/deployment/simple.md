# Basic VPS Deployment

- Create a VPS instance using the vendor of your choice running Debian 12. Infumap does not require a powerful instance (a 0.5Gb low end instance should be fine), but your experience will be snappier if you use one. Anecdotally, I can say that Infumap performs noticeably better running on a Raspberry Pi 5 (a quite powerful CPU) than even a 2 vCPU, 4 GB [high performance Vultr VPS instance](https://www.vultr.com/pricing/#cloud-compute) @ $24 / mo, despite the additional network hops in and out of my living room.
- Register a domain name / create a new subdomain and update the DNS records to point to your new VPS instance.
- `sudo apt update`
- `sudo apt upgrade`
- `sudo apt install caddy tmux git`
- Install rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Determine the latest version of nvm here https://github.com/nvm-sh/nvm (at the time of writing 0.40.1) and install similar to: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`
- Install node: `nvm install node`
- `mkdir git; cd git`
- Clone the infumap project: `git clone https://github.com/infumap/infumap.git`
- `cd infumap`
- TODO: when there is a release, checkout the latest tag.
- `./build.sh`
- `ufw allow https`
- Edit the contents of `/etc/caddy/Caddyfile`:

```
    {
        log {
            output file /var/log/caddy/access.log
            format json
        }
    }

    YOUR_DOMAIN_NAME {
        reverse_proxy 127.0.0.1:8000
    }
```

- Enable: `sudo systemctl enable caddy`
- Start: `sudo systemctl start caddy`
- `tmux`
- `/root/git/infumap/infumap/target/release/infumap web`
- `Ctrl-b d`
