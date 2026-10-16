# Compliance — external metadata

How **kavita-companion** stays inside the terms of every metadata provider it can talk to, and where
each rule is enforced in code. The per-provider reading of the terms lives in
[metadata-providers.md](metadata-providers.md) and
[research/R1](research/R1-manga-anime.md)–[R4](research/R4-kavita-native.md); this page is the summary
that ships with the software.

> **This is documentation, not legal advice.** It is an engineering reading of the providers' published
> terms as captured on 2026-10-16. Terms and licences change; re-check the current page before enabling a
> provider. Enabling a provider is the admin's decision and responsibility.

## What the portal does with provider data

- A provider is called **only** when a reviewer asks for it, on one file at a time
  (**Find metadata** on the review card). Nothing is fetched on upload, on a scan, on a schedule, or
  from the Library browse/queue.
- The reviewer picks a candidate and applies fields; **nothing is auto-applied**, and the merged values
  are written into the user's **own** file (ComicInfo.xml / EPUB OPF) only when the reviewer approves it.
- The portal is **self-hosted, free and ad-free**, and does **not redistribute** provider data: the
  cache is private, is never published, and is purged when a provider is turned off or its key cleared.

## Per-provider obligations

| Provider | Media | Class | Default | Required credit (shown in the UI) |
|---|---|---|---|---|
| Metron | comics | allow | off until enabled | *Comic data from Metron, CC BY-SA 4.0* |
| Grand Comics Database (GCD) | comics | allow | off until enabled | *Comic data from the Grand Comics Database (GCD), CC BY-SA 4.0* |
| MangaDex | manga | allow | off until enabled | *Manga data from MangaDex, Acceptable Usage Policy (credit required)* |
| AniList | manga / light novels | allow (strict) | off until enabled | *Manga data from AniList, API Terms of Use* |
| Hardcover | books | allow, keyed | off until enabled | *Book data from Hardcover, API Terms* |
| Open Library (Internet Archive) | books | allow | off until enabled | *Book data from Open Library, Internet Archive (no new rights asserted)* |

Excluded or deferred: **ComicVine** and **Google Books are excluded** — their terms conflict with
writing data into files or with caching beyond the response header; **PRH is deferred** (an opt-in
follow-up, the only source of a true Imprint/AgeRating); **Jikan, Kitsu and ISBNdb** are excluded (grey
or undefined terms, or paid with a no-redistribution clause).

Obligations the adapters and framework implement:

- **Attribution (Metron, GCD, MangaDex, AniList, Hardcover, Open Library).** Each adapter declares a
  `label` and a `licence`; the credit is composed from them (`attributionFor()`), shown on each
  candidate chip, on the applied card (*Applied from …*), and on **About → Metadata sources** (the
  `/api/metadata-sources` page). Because the text is rendered from adapter metadata it cannot silently
  drift. Every provider must surface a licence name and link; a test asserts it.
- **CC BY-SA 4.0 ShareAlike (Metron, GCD).** The licence is `CC BY-SA 4.0`; commercial use and embedding
  are allowed (Metron ships a tagger that writes into archives). ShareAlike attaches to *adaptations we
  distribute* — this self-hosted portal does not publish users' files, so it does not trigger a public
  distribution obligation. **Any feature that exports, shares or ships fetched Metron/GCD data must
  attach the attribution and the CC BY-SA 4.0 notice, and be licensed CC BY-SA 4.0.** The GPL code and
  the CC BY-SA data are licence-compatible; the code does not become CC BY-SA.
- **Covers excluded from the licence (Metron, GCD).** Cover *art* is the rights holder's / fair use.
  Both adapters declare `covers: "none"`: no cover is ever fetched, proxied, cached or written.
- **MangaDex: credit, no ads, no hotlinking.** A visible credit is required (met); the data may not
  power ads or a paid service (the portal is free and ad-free); a truthful `User-Agent` is mandatory;
  all calls are server-side (its API has no third-party CORS) and **images are never fetched**.
- **AniList: no data-storage / no hoarding.** The API may not be used as a backup or data-storage
  service and mass collection is forbidden. Lookups stay per-review with an intentionally **short cache
  TTL (3 days)**; there is no bulk or mirror code path. Free below **$150/month** revenue — the portal
  must not charge for AniList-derived data and must re-check this if it ever monetises.
- **Hardcover: no LLM training, no user-owned data, image DMCA.** Provider payloads are never sent to an
  LLM; only the public catalogue is used; covers are never fetched (image use would require a DMCA
  policy, so the simplest compliant default is `covers: "none"`).
- **Open Library / Internet Archive.** IA asserts no new copyright and warns existing rights may apply;
  records are passed through with an identified `User-Agent` (set `COMPANION_CONTACT_EMAIL` for the
  3/s tier). No scraping; use the monthly dumps for anything bulk.

## The no-bulk rule (per-review safeguard)

External lookups are **per-review and admin/reviewer-triggered only**:

- one search per enabled provider for one explicit **Match** action; a candidate **fetch** happens only
  after the reviewer picks one (**Apply**);
- **no** background crawler, scheduled refresh, auto-fetch on upload, or related-series fan-out;
- the returned candidate list is **bounded** (`MAX_MATCH_CANDIDATES = 8`);
- the reviewer-only **Library** browse and "needs metadata" queue read **only Kavita's own catalogue**
  and never call a provider.

Where a bulk path could be introduced: `matchFor()` in `src/review.ts` (the only place the reviewer flow
searches providers), the admin dry-run route in `src/providers/routes.ts`, and the Library view in
`src/library.ts` — each carries a comment stating the invariant. `tests/test_providers_safeguard.py`
asserts it against the fake provider (one Match = one bounded upstream call; a browse/queue = zero;
nothing in the background).

## Caching policy

Cache lives in the `metadata_cache` table of the portal database (`data/companion/companion.db`), keyed
by provider + external id. **It is never a redistributable mirror:** rows carry the provider's licence
and attribution, are purged on expiry (hourly job), and the whole provider's rows are dropped the moment
its key is cleared or the provider is turned off.

| Provider | Stored | TTL | Notes |
|---|---|---|---|
| Metron | record JSON + IDs | 30 d | no cover images |
| GCD | record JSON + IDs | 30 d | no cover images; no bulk dump imported |
| MangaDex | record JSON + IDs | 7 d | no images on disk |
| AniList | record JSON + IDs | 3 d | transient by design (no-storage rule) |
| Hardcover | record JSON + IDs | 30 d | per-install PAT |
| Open Library | record JSON + IDs | 30 d | identified UA |

Records are stored as our own field names; a cache hit never re-calls the provider. Searches are not
cached, so each Match is a fresh (bounded) lookup.

## Key handling policy

- **No keys ship.** `.env.example` lists every `PROVIDER_<ID>_KEY` empty. Each install supplies its own
  free per-install key (Metron bearer token, Hardcover PAT, optional GCD account); MangaDex, AniList and
  Open Library need none.
- **Sealed at rest.** An admin key is encrypted with **AES-256-GCM** (`src/seal.ts`, key derived from
  `COMPANION_SECRET`) before it is written to `provider_config.key_sealed`; only the last four characters
  (`key_hint`) are stored in the clear, for display.
- **Never returned.** No route echoes a key — the admin panel and the About page return only booleans
  (`keyed` / `configured` / `hasKey`) and the hint. The key field is write-only in the UI.
- **Never logged.** Keys travel in `Authorization` headers or request bodies, which the logger does not
  record; the request-log URL redactor also strips `apiKey`, `key`, `token`, `api_key` and
  `access_token` query parameters defensively.
- **`.env` override wins.** A `PROVIDER_<ID>_KEY` value seeds/pins a key for operator-managed installs;
  it takes precedence over the sealed DB value.
- Tests assert the sealed round-trip and that the plaintext key appears in neither the API responses nor
  the database files (`tests/test_providers_framework.py`).

## Defaults: allow / opt-in / exclude

External metadata is **off entirely by default** (`METADATA_EXTERNAL_ENABLED=false`) and every provider
is off until an admin turns it on. When external metadata is enabled the intended ordering is Metron →
GCD (comics), MangaDex → AniList (manga/light novels), Hardcover → Open Library (books). Changing a
provider's state or key is an admin action recorded in the audit log; turning one off purges its cached
records and series links. The **About → Metadata sources** page always shows what is built in, on/off and
needs-a-key.

Rate limits are honoured by the shared client (`src/providers/http.ts`): a per-provider token bucket, a
`Retry-After`/`429` cooldown, a short timeout, a response size cap and a truthful `User-Agent`
(`kavita-companion/<version> (+<PUBLIC_ORIGIN>)`, plus `COMPANION_CONTACT_EMAIL` when set).

## Before enabling a provider

Re-read its current ToS/licence, confirm the credit appears on the review card and the About page,
confirm the rate-limit and cache settings match this page, confirm no key ships and no bulk path exists,
and confirm no provider image is written to a file. The full per-provider checklist is in
[roadmap-phase2.md](roadmap-phase2.md) §4. **This is not legal advice.**
