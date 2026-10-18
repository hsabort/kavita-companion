# Host notes

Things that live outside Docker and depend on the host. None of this is needed on an ordinary Linux
server with Docker; it documents what an **unprivileged Incus/LXC container** needs (the original
deployment runs in one).

## Files here

| File | Use |
|---|---|
| `install-docker.sh` | Installs Docker Engine + compose plugin from Docker's official apt repository (Ubuntu). Run with sudo. |
| `fix-docker-storage.sh` | Sets Docker's storage driver to `btrfs`. Needed when the container's root is an idmapped btrfs filesystem, where overlayfs can't mount. Run with sudo. |

## Incus/LXC container checklist (run on the Incus host)

1. **Nesting** (Docker inside the container). Without it containers with their own network fail with
   `open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied`:
   ```bash
   incus config set <instance> security.nesting=true \
     security.syscalls.intercept.mknod=true security.syscalls.intercept.setxattr=true
   incus restart <instance>
   ```
2. **A fixed address** for the container, so forwards keep working after restarts:
   ```bash
   incus config device override <instance> eth0 ipv4.address=<ip>
   ```
3. **Port forwarding.** Incus `proxy` devices connect to the container's **127.0.0.1**, so inside the
   container anything bound to `127.0.0.1` or `0.0.0.0` on a forwarded port is public. (The stack binds
   Kavita's local port to the Docker gateway for that reason.)
4. **Real client IPs.** Through a proxy device every visitor appears as the same address. Enable the
   PROXY protocol for the HTTPS ports only, and keep services that can't parse it (SSH) on their own
   device. Do both steps together; the first one alone removes the SSH forward:
   ```bash
   incus config device set <instance> ports listen=tcp:0.0.0.0:<first>-<last> \
     connect=tcp:127.0.0.1:<first>-<last> proxy_protocol=true
   incus config device add <instance> ssh proxy listen=tcp:0.0.0.0:<ssh-port> connect=tcp:127.0.0.1:<ssh-port>
   ```
5. **Let's Encrypt** needs port 80 of the domain. If the Incus host's web server owns port 80, forward
   only `/.well-known/acme-challenge/` to the container's `ACME_HTTP_PORT` (Apache/nginx examples in
   `docs/install.md`).

## An example deployment

For reference, a working deployment looks like this: the container's HTTPS ports forwarded with
`proxy_protocol=true`, SSH on its own device (it cannot parse the header), and the host's web server
forwarding ACME checks for the domain to the container's `ACME_HTTP_PORT` — Docker on btrfs, container
user matching `PUID`/`PGID`. Substitute your own instance name, address range, domain and config path.
