# Decisions

Short records of choices that shape this project, newest last. Each says what was decided and why.

1. **Kavita from the linuxserver.io image**, version pinned in `.env`. Supports `PUID/PGID` (non-root);
   upgrades are deliberate.
2. **Library folders read-only for Kavita.** Only the portal writes to them, and only after an admin
   approves.
3. **Upload portal instead of shared folders.** Kavita has no media-upload API (its Upload endpoints are
   for cover images), so a separate service accepts files and files them into the library.
4. **Sign in with Kavita accounts.** No second user database; Kavita roles decide who uploads (not
   Read Only) and who reviews (Admin). Roles are re-checked every 2 minutes.
5. **Everything is reviewed before it reaches readers.** Uploads wait in a staging area Kavita can't see.
6. **Resumable uploads (tus + Uppy).** Large files from phones must survive dropped connections.
7. **TypeScript on Node 24 with the built-in SQLite**, everything built in Docker: no native modules,
   nothing to install on the host.
8. **Caddy for HTTPS** with Let's Encrypt HTTP-01 on a configurable port, so the stack works where
   ports 80/443 belong to another web server (the challenge path is forwarded).
9. **Staging inside the media folder** (`MEDIA_ROOT/.incoming`): same filesystem as the libraries, so
   approving even an 8 GB file is an instant rename.
10. **Fix names and metadata in the file at review time.** Kavita trusts embedded metadata
    (ComicInfo.xml, EPUB OPF) over folder and file names, so the approved series is written into the
    file. Fixing it only in Kavita's database would not survive a rescan.
11. **Always repack comic archives as CBZ on approval.** RAR can't be written (proprietary), CBZ is what
    Kavita handles best, and every comic then carries a clean ComicInfo.xml with the approved values.
    Pages are stored unchanged.
12. **Official 7-Zip build for reading archives** (pinned and checksummed): Alpine's package has no RAR
    support. **yazl for writing zips**, because 7-Zip reorders entries (EPUB needs `mimetype` first).
13. **Approval runs as a background job**, one at a time, so large repacks don't tie up the browser and
    failures return the upload to the queue.
14. **Real client IPs via PROXY protocol** from the TCP forwarder in front of the host, accepted by Caddy
    only from the Docker gateway. Needed for per-IP limits and a meaningful audit log.
15. **Look like Kavita, and link from Kavita's sidebar** (Kavita "external source" entry + sign-in with the
    user's own key). The sidebar link is the supported integration point; injecting code into Kavita's
    pages was rejected as fragile and a security risk.
16. **One script to stand it up.** `setup.sh` needs only bash and Docker; first-run work against Kavita's
    API runs inside the portal's image. Everything host-specific lives in `.env`.
17. **GPL-3.0-or-later for this repository.** The repository includes Kavita's logo, favicon and API
    description (GPL v3) and reproduces Kavita's look, so the whole project uses Kavita's licence family.
    All third-party code used is GPL-compatible (MIT, ISC, BSD, Apache-2.0, BlueOak); the OFL fonts ship
    with their licence. Details in `NOTICE.md`.
18. **Follow the user's Kavita theme by reading colour variables only.** Any installed theme (built-in or
    from Kavita's catalogue or uploaded) recolours the portal, while the theme's CSS itself is never
    applied, so themes can't inject layout changes, third-party fonts or anything else.
19. **Only failed sign-ins count toward sign-in limits**, so frequent or shared-network users are never
    locked out while password guessing still is.

## Metadata providers — open items (docket)

- **Never write `<Volume>` into a comic's ComicInfo** (0.6.6). Kavita treats a comic whose ComicInfo
  volume the folder doesn't encode as a *different series*; a folder scan then silently drops the file
  and removes its chapters. Comics never emit `Volume` now, and a fix clears any an older write left
  behind — Kavita derives volume from the folder/filename.
- **GCD: enable with a free account, and only after the throttler fix.** The API takes HTTP Basic
  `user:pass` (verified: bad credentials → `401 Invalid username/password`), raising the limit from
  30/hour to 2,000/day. Steps: create a free account at comics.org, then supply `username:password`
  (stored encrypted in the DB, or via `.env`). It stays **off** until then, and until `providerFetch`
  *skips* a long wait and reports a cooldown instead of sleeping through it (a 120 s anonymous spacing
  currently holds the HTTP request open — see `docs/metadata-providers.md`).
- **Review UX — the "Find metadata" click flow.** The candidate list, "Apply selected fields" and the
  per-field source chips all live inside the wide review card; consider a focused dialog for the
  choose-and-apply step (raised after fixing Star Wars #076/#077).
- **Hold 1.0** until the product review (`docs/product-review-plan.md`) is done.
