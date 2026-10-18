# Notices

## Copyright

```
kavita-companion
Copyright 2026 James VanTassel
```

This file is the **NOTICE** text file for the purposes of Apache License 2.0 section 4(d):
redistributions of this work (or derivative works) must keep the attribution above. Everything below
that section records the licences of third-party material and is informational.

## Licence

This repository (the Docker configuration, `setup.sh`, scripts, tests, documentation and
**kavita-companion**) is licensed under the **Apache License 2.0**; see [LICENSE](LICENSE).
Contributions are accepted under the same licence and require a `Signed-off-by` sign-off — see
[CONTRIBUTING.md](CONTRIBUTING.md).

Two container images are published from one Dockerfile:

| Image | Contains | SPDX `org.opencontainers.image.licenses` |
|---|---|---|
| `ghcr.io/hsabort/kavita-companion:X.Y.Z` — the **permissive default**, and what an unqualified pull means | this repository's Apache-2.0 code and the SIL OFL 1.1 fonts | `Apache-2.0 AND OFL-1.1` |
| `ghcr.io/hsabort/kavita-companion:X.Y.Z-formats` — the **combined work** | the default plus 7-Zip and KindleUnpack (below) | `Apache-2.0 AND OFL-1.1 AND GPL-3.0-only AND LGPL-2.1-or-later` |

The **formats image** is a combined work and is *not* Apache-2.0 on its own: it bundles 7-Zip
(LGPL-2.1-or-later with the unRAR restriction) and KindleUnpack (GPL-3.0-only), so that image as a
whole is distributed under GPL-3.0. It is never tagged `latest`. Each image's label names our
licence, the fonts, and the copyleft components — our Apache-2.0, the OFL fonts, and, in the formats
image, GPL-3.0-only and LGPL-2.1-or-later; permissive dependencies such as `loguru` (MIT) and
`standard-imghdr` (PSF-2.0) are listed in the table below.

### Historical material, outside the grant

Three third-party GPL files were added in `24f186c` (kavita-companion 0.2.0) and removed from the tree
in `d5a5dff` (clean-room remediation). They were then **purged from the repository's history** on
2026-10-18 with `git filter-repo` 2.47.0 (stripping the three blobs by object id across every branch
and tag), so no clone receives them any more:

| Blob | Path at the time | What it is | Licence |
|---|---|---|---|
| `5d2a71c` | `docs/reference/kavita-openapi-v0.9.1.4.json` | Kavita's OpenAPI description | GPL-3.0 |
| `6881384` | `kavita-companion/public/assets/img/kavita-logo.png` | Kavita's logo | GPL-3.0 |
| `5e6c75d` | `kavita-companion/public/assets/img/favicon-32.png` | Kavita's favicon | GPL-3.0 |

**These historical blobs are not part of the Apache-2.0 grant.** They are third-party GPL-3.0 material
that was included by mistake and has since been removed. The purge rewrote every commit id, so commit
references recorded before 2026-10-18 no longer resolve; the statement below is retained because the
material is still reachable through two GitHub-managed pull-request refs (`refs/pull/1/head` and
`refs/pull/2/head`, from dependabot branches that predate the clean-room remediation). Those refs
cannot be rewritten from a clone — removing them needs GitHub Support to expire the refs and garbage
collect — and until that happens the blobs remain under Kavita's GPL-3.0, with copyright held by their
authors, and the Apache-2.0 licence above does not apply to them. Nothing in the current tree depends
on them or is derived from them.

## Third-party material included in this repository

| Material | Location | Source | Licence |
|---|---|---|---|
| Poppins font | `kavita-companion/public/assets/fonts/Poppins.woff2` | Kavita v0.9.1.4 web UI, unmodified | SIL Open Font License 1.1 (`OFL-Poppins.txt`) |
| League Spartan font | `kavita-companion/public/assets/fonts/LeagueSpartan-VariableFont_wght.ttf` | Kavita v0.9.1.4 web UI, unmodified | SIL Open Font License 1.1 (`OFL-LeagueSpartan.txt`) |

kavita-companion talks to Kavita only through its HTTP API, and its own mark, palette and layout are
original work chosen to sit alongside Kavita's UI; no Kavita source code, schema, strings or assets
are included. See [docs/clean-room.md](docs/clean-room.md).
Kavita itself is not part of this repository: the stack runs the separately distributed
[linuxserver.io Kavita image](https://docs.linuxserver.io/images/docker-kavita/) (GPL v3, source at
https://github.com/Kareadita/Kavita).

## Third-party software used when building or running

Not stored in this repository; fetched at build time and pinned:

| Software | Used for | Licence |
|---|---|---|
| Node.js packages (`kavita-companion/package-lock.json`): Fastify and plugins, @tus/server, yazl, yauzl, fast-xml-parser and their dependencies | portal server | MIT, ISC, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0 |
| Uppy, Preact, tus-js-client and dependencies | bundled into the portal's web page | MIT |
| TypeScript, esbuild | build only | Apache-2.0, MIT |
| 7-Zip 26.01 (`7zzs`, official Linux build, SHA-256 pinned in the Dockerfile) | reading `.rar`/`.7z` archives in the formats image | GNU LGPL 2.1+ with the unRAR licence restriction, BSD; licence text shipped in the image at `/usr/local/share/doc/7zip/License.txt`. The unRAR code is used only to extract, never to create RAR archives. |
| `mobi` 0.4.1 (PyPI, pinned in the Dockerfile) — a repackaging of KindleUnpack | converting MOBI/AZW book uploads to EPUB in the formats image | GNU GPL v3 **only** (not "or later"); licence text shipped in the image at `/usr/local/share/doc/kindleunpack/LICENSE`. Package source: https://github.com/iscc/mobi (derived from KindleUnpack, https://github.com/kevinhendricks/KindleUnpack) |
| `loguru` 0.7.3 and `standard-imghdr` 3.13.0, installed as `mobi`'s dependencies | `mobi`'s runtime imports in the formats image | MIT (`loguru`), PSF-2.0 (`standard-imghdr`). Both travel in the formats image: `standard-imghdr` ships its own licence file, and `loguru`'s wheel carries none, so its MIT text is fetched from upstream at build time (pinned by URL and SHA-256) into `/usr/local/share/doc/kindleunpack/`. This closes the gap previously recorded here. |
| Caddy, Kavita, Node.js base images | containers | Apache-2.0, GPL-3.0, MIT (respectively) |

## Metadata provider credits

kavita-companion can query external metadata providers (off by default, one lookup per reviewer
action). It stores no provider data in this repository — the test fixtures are synthetic — and none of
its users' files or the portal's cache are redistributed. Where provider data is shown, or if it is ever
exported, these credits apply (rendered from each adapter's metadata; see
[docs/compliance.md](docs/compliance.md)):

| Provider | Credit |
|---|---|
| Metron | Comic data from Metron, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Grand Comics Database (GCD) | Comic data from the Grand Comics Database (GCD), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| MangaDex | Manga data from MangaDex, [Acceptable Usage Policy](https://api.mangadex.org/docs/) |
| AniList | Manga data from AniList, [API Terms of Use](https://docs.anilist.co/) |
| Hardcover | Book data from Hardcover, [API Terms](https://hardcover.app/pages/policies) |
| Open Library | Book data from Open Library, [Internet Archive terms](https://openlibrary.org/developers/api) |

*This is documentation, not legal advice.*
