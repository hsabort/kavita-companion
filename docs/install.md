# Installing

## Requirements

- A Linux host (tested on Ubuntu 24.04) with **Docker Engine** and the **compose plugin**.
  `host/install-docker.sh` installs both from Docker's official repository on Ubuntu.
- The user running `setup.sh` must be able to use Docker (member of the `docker` group). `sudo` is only
  needed if the data or media folders can't be created/owned by that user.
- A **domain name** whose DNS points at the server.
- Three free TCP ports on the host (defaults in brackets): Kavita HTTPS (20005), portal HTTPS (20004)
  and a plain-HTTP port for Let's Encrypt checks (20003). A fourth (20001) is used only on the Docker
  network, never publicly.
- Disk: the media library plus room for uploads waiting for review (the portal refuses uploads when
  free space would drop below 25 GB).

## HTTPS certificates

Caddy gets certificates from Let's Encrypt with the **HTTP-01** check: Let's Encrypt fetches
`http://<DOMAIN>/.well-known/acme-challenge/<token>` **on port 80**. Caddy answers those requests on
`ACME_HTTP_PORT`. Pick one:

1. **This host owns port 80:** set `ACME_HTTP_PORT=80`. Nothing else to do.
2. **Another web server owns port 80** (common on shared hosts): forward just the challenge path to
   `ACME_HTTP_PORT`. Everything else on port 80 is untouched.

   Apache (`a2enmod proxy proxy_http`):
   ```apache
   <VirtualHost *:80>
       ServerName kavita.example.com
       DocumentRoot /var/www/html
       ProxyPreserveHost On
       ProxyPass        /.well-known/acme-challenge/ http://<host-ip>:20003/.well-known/acme-challenge/
       ProxyPassReverse /.well-known/acme-challenge/ http://<host-ip>:20003/.well-known/acme-challenge/
   </VirtualHost>
   ```
   nginx:
   ```nginx
   server {
       listen 80;
       server_name kavita.example.com;
       location /.well-known/acme-challenge/ { proxy_pass http://<host-ip>:20003; proxy_set_header Host $host; }
   }
   ```

Certificates are requested the first time each HTTPS port is visited and renewed automatically.
TLS-ALPN checks are disabled because the HTTPS ports are not 443.

## Install

```bash
sudo mkdir -p /srv/kavita && sudo chown "$USER": /srv/kavita
git clone https://github.com/hsabort/kavita-companion.git /srv/kavita
cd /srv/kavita
./setup.sh
```

`setup.sh`:

1. checks Docker;
2. creates `.env` from `.env.example`, asking for the domain, the three ports, the media folder and
   the time zone (user/group IDs are taken from the current user);
3. creates `data/` and the media folders (`manga`, `comics`, `books`, `.incoming`) owned by that user;
4. pulls Kavita and Caddy, builds kavita-companion;
5. starts Kavita and, on a new install, asks for an admin username and password, creates that admin,
   the **Manga**, **Comics** and **Books** libraries, and an auth key the portal uses (saved in `.env`);
   on an existing Kavita it asks for an existing admin's credentials once, to create the key;
6. starts everything and waits until the portal is healthy.

Running it again is safe: it keeps `.env` (adding any new settings with their defaults), and only
creates a new portal key if the saved one stops working.

### Without prompts (automation)

Every setting in `.env.example` can be supplied as an environment variable, plus the admin account:

```bash
DOMAIN=kavita.example.com MEDIA_ROOT=/srv/media \
KAVITA_ADMIN_USERNAME=admin KAVITA_ADMIN_PASSWORD='a long password' \
./setup.sh --non-interactive
```

### Moving an existing Kavita here

Stop the old Kavita, copy its `/config` folder to `data/kavita/`, put the library folders under
`MEDIA_ROOT` as `manga/`, `comics/` and `books/` (or adjust the volumes in `compose.yaml`), then run
`setup.sh` and give it an existing admin's credentials when asked.

## After installing

- Open Kavita (`https://<DOMAIN>:<KAVITA_HTTPS_PORT>`) and sign in as the admin.
- Each user should sign in to the portal (`https://<DOMAIN>:<COMPANION_HTTPS_PORT>`) once with their
  Kavita password. That adds **Uploads** to their Kavita sidebar; from then on that link signs them in.
  (Read Only accounts don't get the link: Kavita won't create keys for them, and they can't upload.)
- Kavita files each series in its own folder. Files placed directly in `manga/`, `comics/` or `books/`
  are ignored by Kavita; the portal always files uploads into series folders.

## Settings reference

All settings live in `.env`; `.env.example` documents each one. The ones you are most likely to change:

| Setting | Default | Meaning |
|---|---|---|
| `DOMAIN` | (required) | Hostname for the certificates |
| `KAVITA_HTTPS_PORT` / `COMPANION_HTTPS_PORT` | 20005 / 20004 | Public HTTPS ports |
| `ACME_HTTP_PORT` | 20003 | Port where Caddy answers Let's Encrypt checks |
| `MEDIA_ROOT` | /srv/media | Library and upload staging |
| `DATA_ROOT` | ./data | Databases and certificates |
| `PUBLISH_ADDRESS` | 0.0.0.0 | Address the public ports are bound to |
| `DOCKER_SUBNET` / `DOCKER_GATEWAY` | 172.30.0.0/24 / .1 | Private Docker network (change if it clashes) |
| `MAX_FILE_GB`, `MAX_PENDING_GB_PER_USER`, `MAX_CONCURRENT_UPLOADS_PER_USER`, `MIN_FREE_DISK_GB` | 8, 50, 3, 25 | Upload limits |

After changing `.env`, apply it with `docker compose up -d`.

## Special hosts

- **Unprivileged Incus/LXC containers** need nesting enabled, the btrfs storage driver on btrfs, and
  care with port forwarding. See [host/README.md](../host/README.md).
- **Real client IPs behind a TCP forwarder:** if connections reach this host through a TCP proxy that
  connects to `127.0.0.1` (for example an Incus `proxy` device), every visitor looks like the same
  address. Enable the PROXY protocol on that forwarder (`proxy_protocol=true` on Incus) for the HTTPS
  ports; Caddy already accepts it (see [architecture.md](architecture.md#networking)). Don't enable it
  on ports used by services that can't parse it, such as SSH.
