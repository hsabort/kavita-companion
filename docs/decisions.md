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
    *(Superseded by 20: the Kavita material has been removed and the repository is now Apache-2.0.)*
    All third-party code used is GPL-compatible (MIT, ISC, BSD, Apache-2.0, BlueOak); the OFL fonts ship
    with their licence. Details in `NOTICE.md`.
18. **Follow the user's Kavita theme by reading colour variables only.** Any installed theme (built-in or
    from Kavita's catalogue or uploaded) recolours the portal, while the theme's CSS itself is never
    applied, so themes can't inject layout changes, third-party fonts or anything else.
19. **Only failed sign-ins count toward sign-in limits**, so frequent or shared-network users are never
    locked out while password guessing still is.

20. **Relicensed to Apache-2.0** (2026-10-18), from GPL-3.0-or-later, with `Copyright 2026 James
    VanTassel`. The repository was sole-authored (one commit identity, no CLA, no third-party
    contributions), so the grant is clean; copies distributed earlier keep their GPL-3.0-or-later
    rights. The code is AI-written under human direction — the architecture, product decisions and
    behaviour were chosen and reviewed by the owner — and the licence rests on that human
    contribution. The signed statement is kept outside the repository
    (`~/kavita-companion-relicensing.md`). Apache-2.0 rather than MIT for the explicit patent grant
    and the NOTICE/attribution mechanics, since the rules are offered to a closed-source consumer.
21. **The container image is a combined work, and is labelled as one.** It bundles KindleUnpack
    (GPL-3.0-only) and 7-Zip (LGPL-2.1-or-later with the unRAR restriction), so it cannot be
    Apache-2.0 on its own: the image label names all four licences, and the image now ships our
    `LICENSE`, `NOTICE.md`, and 7-Zip's and KindleUnpack's licence texts. It previously shipped no
    licence text at all, which was a real GPL gap.
22. **The Docker build context is the repository root** (`dockerfile: kavita-companion/Dockerfile`), so
    the Dockerfile can copy `LICENSE` and `NOTICE.md` from their single source of truth rather than
    keeping copies inside the app directory.
23. **A dependency licence gate runs in CI** (`npm run licences`): permissive licences only, failing on
    copyleft or undeclared. `combine-errors` (transitive via `tus-js-client`, declares nothing
    upstream) is a documented exception until its compliance item is resolved.

## Metadata providers — open items (docket)

- **Never write `<Volume>` into a comic's ComicInfo** (0.6.6). Kavita treats a comic whose ComicInfo
  volume the folder doesn't encode as a *different series*; a folder scan then silently drops the file
  and removes its chapters. Comics never emit `Volume` now, and a fix clears any an older write left
  behind — Kavita derives volume from the folder/filename.
- **GCD: enabled with an account key (0.6.7).** A free comics.org account's `user:pass` is stored
  encrypted in the DB and sent as HTTP Basic (verified live: `200 OK`; raises the limit from 30/hour to
  2,000/day, and the adapter's spacing drops from 120 s to 5 s). Its optional key is now managed in
  About → Metadata providers (the `optionalKey` registration flag; the admin API reports `hasKey` for
  any provider that has one). Still worth doing: make `providerFetch` *skip* a long wait and report a
  cooldown instead of sleeping through it, so the anonymous 120 s case can never hold a request open
  (see `docs/metadata-providers.md`).
- **Review UX — the "Find metadata" click flow.** The candidate list, "Apply selected fields" and the
  per-field source chips all live inside the wide review card; consider a focused dialog for the
  choose-and-apply step (raised after fixing Starfall #076/#077).
- **MOBI/AZW3 support (built, 0.6.9).** Kavita reads EPUB/PDF only, so Kindle books used to be refused
  at upload. Now `.mobi`/`.azw`/`.azw3` are accepted **in a Books library** and converted to EPUB on
  upload-complete with **KindleUnpack** (the `mobi` PyPI package, pure Python, GPL-3.0) — Python lives in
  a venv in the portal image. KF8 books come out as a finished EPUB; MOBI6 books are assembled from
  KindleUnpack's HTML tree (adding `mimetype` + `META-INF/container.xml`). DRM-protected or unreadable
  files are refused with a plain reason, and DRM is never stripped. KindleUnpack reads the format from
  the file *name*, so the converter stages a copy with its extension first.
- **Hold 1.0** until the product review (`docs/product-review-plan.md`) is done.
