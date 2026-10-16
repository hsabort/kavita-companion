# Notices

This repository (the Docker configuration, `setup.sh`, scripts, tests, documentation and
**kavita-companion**) is licensed under the **GNU General Public License v3.0 or later**; see
[LICENSE](LICENSE).

## Third-party material included in this repository

| Material | Location | Source | Licence |
|---|---|---|---|
| Kavita logo and favicon | `kavita-companion/public/assets/img/` | [Kavita](https://github.com/Kareadita/Kavita) v0.9.1.4 web UI, unmodified | GNU GPL v3 |
| Kavita OpenAPI description | `docs/reference/kavita-openapi-v0.9.1.4.json` | Kavita repository, tag v0.9.1.4, unmodified | GNU GPL v3 |
| Poppins font | `kavita-companion/public/assets/fonts/Poppins.woff2` | Kavita v0.9.1.4 web UI, unmodified | SIL Open Font License 1.1 (`OFL-Poppins.txt`) |
| League Spartan font | `kavita-companion/public/assets/fonts/LeagueSpartan-VariableFont_wght.ttf` | Kavita v0.9.1.4 web UI, unmodified | SIL Open Font License 1.1 (`OFL-LeagueSpartan.txt`) |

Kavita's colours and layout conventions are followed so the portal looks like part of Kavita; no
Kavita source code is included. kavita-companion talks to Kavita only through its HTTP API.
Kavita itself is not part of this repository: the stack runs the separately distributed
[linuxserver.io Kavita image](https://docs.linuxserver.io/images/docker-kavita/) (GPL v3, source at
https://github.com/Kareadita/Kavita).

## Third-party software used when building or running

Not stored in this repository; fetched at build time and pinned:

| Software | Used for | Licence |
|---|---|---|
| Node.js packages (`kavita-companion/package-lock.json`): Fastify and plugins, @tus/server, yazl, fast-xml-parser and their dependencies | portal server | MIT, ISC, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0 |
| Uppy, Preact, tus-js-client and dependencies | bundled into the portal's web page | MIT |
| TypeScript, esbuild | build only | Apache-2.0, MIT |
| 7-Zip 26.01 (`7zzs`, official Linux build, SHA-256 pinned in the Dockerfile) | reading archives in the portal image | GNU LGPL 2.1+ with the unRAR licence restriction, BSD; licence text shipped in the image at `/usr/local/share/doc/7zip/License.txt`. The unRAR code is used only to extract, never to create RAR archives. |
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
