# Security

## What is exposed

| Port | Service | Notes |
|---|---|---|
| `KAVITA_HTTPS_PORT` | Kavita via Caddy | HTTPS only |
| `COMPANION_HTTPS_PORT` | kavita-companion via Caddy | HTTPS only |
| `ACME_HTTP_PORT` | Caddy plain HTTP | Let's Encrypt checks; anything else is redirected to HTTPS |
| `KAVITA_LOCAL_PORT` | Kavita plain HTTP | Bound to `DOCKER_GATEWAY` only: reachable from the host (admin tools, tests), never from outside |

kavita-companion itself is not published. On hosts where a TCP forwarder lands traffic on the host's
loopback (e.g. Incus proxy devices), anything bound to `127.0.0.1` or `0.0.0.0` is public; that is why
the local Kavita port is bound to the Docker gateway instead.

## Accounts and sessions

- There are no separate portal accounts: users sign in with their Kavita username and password, checked
  by Kavita, or through their Kavita sidebar link (their own Kavita auth key, checked by Kavita).
- Permissions come from Kavita roles: anyone without **Read Only** can upload; **Admins** review.
  Roles are re-read from Kavita at most every 2 minutes, so role changes and disabled/deleted accounts
  take effect in open sessions within about 2 minutes.
- Session cookie: `__Host-kc_session`, random 256-bit token, `HttpOnly`, `Secure`, `SameSite=Strict`,
  12 hours. Only its SHA-256 is stored. Sign-out deletes it server-side.
- The user's Kavita session (token + refresh token, from the password or sidebar-link sign-in) is kept
  with the portal session, **encrypted** (AES-256-GCM with `COMPANION_SECRET`), and used for two things
  only: adding the sidebar link, and re-reading the user's theme preference (at most every 5 seconds,
  when the page asks). It is deleted with the portal session (sign-out or 12-hour expiry). Kavita sessions
  last 72 hours; if one is refused it is renewed once with the refresh token.
- The sidebar link's key is accepted only as a query parameter on `GET /login`, which redirects
  immediately so it leaves the address bar; it is redacted from logs.

## Request protection

- **CSRF:** every state-changing request must carry the portal's own `Origin`, in addition to the
  SameSite=Strict cookie.
- **Rate limits:** only *failed* sign-ins count: 10 per 15 min per (IP, username) and 30 per 15 min per
  IP (password and sidebar-link sign-ins alike); a successful sign-in clears that account's count, so
  people signing in often or from a shared network are never locked out. Everything else: 600 requests
  / min per session (or per IP when signed out). Kavita adds its own account lockout.
- **Headers:** strict Content-Security-Policy (`default-src 'self'`, no inline scripts, no framing),
  HSTS, `nosniff`, same-origin referrers.
- **Real client IPs** are taken from `X-Forwarded-For` only when it comes from Caddy (`DOCKER_SUBNET`),
  and Caddy accepts a PROXY protocol header only from `DOCKER_GATEWAY`.

## Themes

The portal follows each user's Kavita theme. It reads only the theme's CSS custom properties from the
theme's main rule, keeps a fixed list of colour variables, and accepts only plain colour values (hex,
names, `rgb()`/`hsl()`); everything else, including `url()`, imports and layout rules, is ignored. Values
are applied as CSS custom properties through the CSSOM, never as style text, so a custom theme uploaded to
Kavita can't inject styles or load anything into the portal.

## Uploaded files

- Refused before any data is transferred: wrong extension, over the size limit, no library, over the
  user's limits, low disk space, Read Only user, foreign Origin.
- After upload: real type checked from the file's first bytes; mismatches are deleted.
- Uploaders can only see, resume or cancel their own uploads.
- Staging (`MEDIA_ROOT/.incoming`) is outside every Kavita library, so nothing reaches readers before an
  admin approves it.
- Archives are opened only during review/approval, by 7-Zip, after checking their listing: no absolute
  paths, no `..`, no links, at most 20,000 entries, and an expanded size limit against zip bombs. The
  extracted tree is checked again before use. Work happens in a per-upload folder that is deleted after.
- Approved names are sanitised (no path separators, control or reserved characters, leading dots) and
  the destination is verified to be inside the chosen library; existing files are never overwritten.

## Notifications

A user can ask to be told about their own uploads through a webhook, ntfy or Discord. The target is a
URL the user supplies and the portal calls server-side, so to limit server-side request forgery
(SSRF): only `http(s)` is accepted; unless `NOTIFY_ALLOW_PRIVATE=true`, `https` is required and
loopback/link-local/private addresses are refused; requests have a short timeout. Payloads contain only
that user's own file names and statuses, never other users' data or secrets.

## Containers

- kavita-companion and Caddy: read-only root filesystem, `no-new-privileges`, all Linux capabilities
  dropped (Caddy keeps only `NET_BIND_SERVICE`), running as `PUID:PGID`.
- Kavita (linuxserver image) needs root briefly at start-up and then runs as `PUID:PGID`.
- Kavita's library mounts are read-only; only kavita-companion can write to the libraries.
- Third-party versions are pinned: Kavita and Caddy image tags in `.env`, Node packages in
  `package-lock.json`, 7-Zip by version and SHA-256 in the Dockerfile.

## Secrets

| Secret | Where | Notes |
|---|---|---|
| Portal's Kavita auth key | `.env` (`COMPANION_KAVITA_AUTH_KEY`) | Admin-level. `setup.sh` creates it; revoke it in Kavita (User Settings → Auth Keys) and rerun `setup.sh` to replace it. |
| Session encryption secret | `.env` (`COMPANION_SECRET`) | Generated by `setup.sh`. Changing it only means open sessions follow theme changes again after their next sign-in. |
| Metadata provider keys | portal admin panel (`provider_config`, sealed) or `.env` (`PROVIDER_<ID>_KEY`) | Per-install and admin-supplied; ship none. Sealed with AES-256-GCM (`COMPANION_SECRET`), write-only in the UI, never returned by a route and never logged. See [compliance.md](compliance.md#key-handling-policy). |
| Test account passwords | `.env` (`TEST_*`) | Only for `tests/`; leave empty in production and delete the accounts. |
| Kavita's signing key and database | `data/kavita/` | |
| Portal database (sessions, audit log) | `data/companion/` | |

`.env` is created with mode 600, and `data/`, `backups/` and `.env` are git-ignored. Backups made by
`scripts/backup.sh` contain `.env` and are mode 600.

## Audit log

The portal records sign-ins (and failures), uploads, approvals, rejections, restores, sidebar-link
changes and revoked sessions with user and client IP in the `audit_log` table of
`data/companion/companion.db`.

## Known limits

- Users who never sign in to the portal with their password don't get the sidebar link (Kavita doesn't
  let an admin create keys for other users, by design).
- The Kavita sidebar link always opens in a new tab (Kavita behaviour).
