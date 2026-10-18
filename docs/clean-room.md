# Clean-room rules

This project is developed under a clean-room discipline. Kavita is **GPL-3.0**; we interoperate with
it, and we must not copy from it. These rules exist so that our code, and the rules it encodes, can
be offered to a third party without carrying anything derived from Kavita.

## The rule

**Kavita is a behavioural reference only.** Its UI, its public documentation and its observed
runtime behaviour are fair game. Its *source code, database schema, strings and assets are not.*

### Allowed

- Reading Kavita's **public documentation** (wiki, README, release notes).
- **Observing a running Kavita**: its HTTP API responses, its rendered UI and CSS, its logs.
- **Interoperating** with Kavita's HTTP API — calling endpoints, using its documented DTO field
  names, and mapping its CSS custom properties at runtime. This is integration, not copying.
- Implementing a described behaviour **from scratch** after observing it.

### Forbidden

- Opening, reading, pasting, translating or porting Kavita **source files** (C#/TypeScript).
- Vendoring Kavita **schemas** (e.g. its OpenAPI description) or **assets** (logo, icons, fonts it
  does not license for redistribution).
- Citing Kavita **source symbols or file paths** in our code, comments or docs — if a symbol can
  only be known from the source, it must not appear here.
- Reading Kavita's **database** schema and modelling on it.

### Third-party dependencies

Permissive licences only (MIT, BSD, Apache-2.0, ISC, BlueOak-1.0.0, OFL-1.1). No GPL/AGPL/LGPL.
There is a CI licence gate. Known exceptions and their handling are in the compliance plan
(`docs/superpowers/plans/2026-10-18-kavita-companion-lectern-compliance.md`).

## State of this repository

Remediated on 2026-10-18 (clean-room audit, A1–A4):

| Removed | Why |
|---|---|
| `public/assets/img/kavita-logo.png`, `favicon-32.png` | Kavita assets (GPL-3.0). Replaced with an original mark (`logo.svg`, `favicon.svg`). |
| `docs/reference/kavita-openapi-v0.9.1.4.json` | A Kavita schema (GPL-3.0). Use Kavita's own published docs instead. |
| Kavita-source citations in `public/style.css`, `docs/kavita-api.md`, `docs/research/R4-kavita-native.md` | Named Kavita source files/symbols. Rewritten as observed behaviour. |
| The hardcoded `DARK` map in `src/themes.ts` | Values read out of Kavita source. Unresolvable `var()` references now fall back to our own stylesheet defaults. **The map is gone, but five of its values remain** — see the note below. |
| Kavita source files and a Kavita DLL left in `/tmp` on the dev machine | Process hygiene: the rule covers the *process*, not only the artefacts. |

**On the five remaining colour values.** `src/themes.ts` no longer holds a token map and no longer
reads values out of Kavita's source: it maps Kavita's *CSS custom properties* to our tokens at
runtime, which is exactly the interoperation the rules above allow. But five **colour values** survive
as our own stylesheet's defaults in `public/style.css` (`#212529`, `#4ac694`, `#bd362f`, `#6c757d`,
`#f89406`). This is **relocation, not elimination**, and it is deliberate: a colour value is not
protectable expression, and our rules permit observing a running Kavita.

Two of those values originally coloured the original mark (`logo.svg`, `favicon.svg`), including
`#4ac694`, Kavita's primary green. On 2026-10-18 the mark was **recoloured to this portal's own green,
`#2fa88c`**, so the mark no longer wears Kavita's colour; the portal's *stylesheet* keeps `#4ac694` as
its accent, because that similarity is a design choice for a companion that sits alongside Kavita and
is not a copying question. The mark's green and the accent green are therefore slightly different
values by design.

**Still outstanding** (tracked in the plan): the published image bundles GPL-3.0-only KindleUnpack
and LGPL 7-Zip; those are isolated in Phase 3. Until then the *image* is a combined work even
though this repository is not — the image label names every licence it contains, and the image ships
`LICENSE`, `NOTICE.md` and both third-party licence texts.

## Verify

```sh
# Excludes docs/superpowers/ (Lectern working documents — not committed; see .gitignore).
grep -rniE "dark\.scss|side-nav\.component|KavitaPlusApiService|TryMatchAndLoad|FetchExternalDataTask" \
  . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=data-test --exclude-dir=docs/superpowers   # no matches
grep -rn "kavita-logo\|favicon-32" . --exclude-dir=.git --exclude-dir=docs/superpowers   # no matches
git ls-files docs/reference/                                                             # empty
find /tmp -name '*.cs' -o -name 'Kavita.Server.dll'                                      # empty
```

## Contributing

By contributing you confirm your work was produced under these rules, and you sign off your commits
(DCO). See `CONTRIBUTING.md`.
