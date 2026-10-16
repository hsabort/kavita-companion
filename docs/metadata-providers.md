# Metadata providers — research

Research for **roadmap §5 phase 2**: auto-filling more of the review screen from an external metadata
source (beyond phase 1, which reads the matching series' data already in Kavita). This is **research
only** — no provider integration is built. It exists so the next decision can be made with the facts in
front of us: which source(s), whether to require keys, and whether to lean on Kavita's own Kavita+
subscription instead.

Written 2026-10-16 against Kavita v0.9.1.4. Raw per-agent reports: `R1-manga-anime.md`,
`R2-comic-databases.md`, `R3-books.md`, `R4-kavita-native.md`.

## What we need to fill

Our review editor and its writers cover these fields (ComicInfo for comics, EPUB OPF for books):

`Series, Number, Volume, Title, Summary, Year, Writer, Penciller, Inker, Colorist, CoverArtist,
Publisher, Imprint, Genre, Tags, LanguageISO, AgeRating` (books add ISBN).

No single free source fills them all. Broadly: **titles/summary/year/genre** are easy; **series/volume**
and **creator roles** are hard; **imprint/ISBN/AgeRating** are the hardest.

## The options, at a glance

| Source | Covers | Read auth | Free limit | Paid | Data licence / redistribution | Fit |
|---|---|---|---|---|---|---|
| **Kavita+ (Kavita's own)** | manga+comics+books (Mangabaka, Hardcover, ComicBookRoundup) | Kavita+ license | n/a | **$4/mo or $46/yr**, node-locked | via Kavita's backend; no provider keys | best "least effort" if the admin already pays |
| **Metron** | comics | free account + bearer token | 20/min, 5,000/day | donors → 25k/day | **CC BY-SA 4.0**, commercial OK, embedding OK | best comics primary |
| **GCD** | comics (worldwide, historic) | none (or free account) | 30/hr anon, 2,000/day auth | none | **CC BY-SA 4.0** | best comics fallback/coverage |
| **ComicVine** | comics (mainstream US) | free API key | 200/resource/hr | none | **non-commercial; "no reproduce on any other medium"** | coverage, but legally poor for us |
| **MangaDex** | manga | none (User-Agent + server proxy) | ~5 req/s/IP | none | attribution required, no ads | best manga primary |
| **AniList** | manga + **light novels** | none (GraphQL) | 90/min now 30/min | commercial licence >$150/mo revenue | strict: no data-storage/hoarding | LN primary / manga secondary |
| **Jikan** (unofficial MAL) | manga/LN | none | 60/min, 3/s | none | MAL data, no clean licence | fallback / id resolver |
| **Kitsu** | manga/LN | none | undocumented | none | none stated (all rights reserved) | last-resort filler |
| **Hardcover** | books, manga, LN, some comics | free PAT/OAuth | 5,000/day, 60/min | Supporter 50k/day | no LLM training; cite; no user-data resale | best books primary (series/volume/genres) |
| **Open Library** | books | none | 1/s (3/s identified) | none | IA asserts no new rights | free books fallback |
| **Penguin Random House** | PRH imprints only | free key (manual activation) | unpublished | none | PRH terms; no bulk redistribution | only source with true Imprint + AgeRating |
| **Google Books** | books (huge) | API key | ~1,000/day | none | **no permanent copies; cache-header only; no fees** | last-resort ISBN; risky to cache |
| **ISBNdb** | books (deep) | header key | none | $15–100/mo | cache while subscribed; >1,000-record cap; delete on cancel | only if deep out-of-print needed |
| **BookBrainz / Inventaire** | books | none | polite | none | **CC0** | licence-clean backfills (thin) |

Not viable: WorldCat (subscription; API v1 retired), OverDrive/Libby (partner-only), Kobo (no API),
League of Comic Geeks (no public API), Comic Book Plus (no API), Marvel (portal appears retired) / DC (none).

## Kavita's own metadata (the "build nothing" option)

Kavita v0.9.1.4 has **no direct third-party metadata integration** in the open-source server. External
metadata is exclusively **Kavita+** (`https://plus.kavitareader.com`, **$4/mo or $46/yr**, node-locked to
one instance, supports only the latest 3 stable versions, **50 metadata match/refresh per 24h**), which
aggregates **Mangabaka + Hardcover + ComicBookRoundup**. There are **no per-provider keys**.

The companion can already read what Kavita has (`GET /api/Series/metadata`, external IDs on
`GET /api/Series/{id}`), and could additionally:
- detect the licence (`GET /api/License/has-license`, `/valid-license`, `/info`, `/provider-health`);
- read richer data (`GET /api/Metadata/series-detail-plus`, `GET /api/kavita-plus-audit/entries/series/{id}`);
- trigger a match (`POST /api/Series/match`, `POST /api/Series/update-match` — admin, `[KPlus]`; a new
  upload must be scanned first, so it needs an existing series).

Tradeoff: Kavita+ = near-zero integration effort and no keys, but low control, a per-server cost, a
node-locked licence tied to the latest versions, no ComicVine/MangaDex/AniList metadata, and a closed
backend. Direct provider APIs = free/cheap and fully under our control, at the cost of auth, matching,
rate limits and ToS obligations. *(`POST /api/Series/refresh-metadata` and `/api/Library/refresh-metadata`
are misnamed — they regenerate covers, not metadata.)*

## Field coverage (✓ direct · ◐ partial/needs parsing · ✗ absent)

| Field | Metron | GCD | ComicVine | MangaDex | AniList | Hardcover | Open Library | PRH |
|---|---|---|---|---|---|---|---|---|
| Series | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ |
| Number | ✓ | ✓ | ✓ | ◐ | ◐ | ✓ | ◐ | ◐ |
| Volume | ✓ | ◐ | ◐ | ◐ | ◐ | **✓** | ◐ | ✓ |
| Title | ◐ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Summary | ◐ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ |
| Year | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Writer | ✓ | ✓ | ✓ | ◐ | ◐ | ✓ | ✓ | ✓ |
| Penciller/Inker/Colorist/CoverArtist | ✓ | ✓ | ✓ | ✗ | ◐ | ✗ | ✗ | ✗ |
| Publisher | ✓ | ✓ | ✓ | ✗ | ✗ | ◐ | ✓ | ✓ |
| Imprint | **✓** | ◐ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| Genre | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ◐ | ✓ (BISAC) |
| Tags | ✓ | ◐ | ◐ | ✓ | ✓ | ✓ | ◐ | ◐ |
| LanguageISO | **✓** | ✗ | ✗ | ◐ | ◐ | ✓ | ◐ | ✓ |
| AgeRating | ✓ | ◐ | ✗ | ◐ | ◐ | ✗ | ✗ | **✓ (age/grade)** |
| ISBN | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |

## Licensing — the part that decides it

Because we **write fetched data into users' files** and the project is GPL and potentially redistributed,
the source's licence matters as much as its fields.

- **Safe with attribution:** **Metron** and **GCD** (both **CC BY-SA 4.0**, commercial use and embedding
  explicitly allowed; Metron even ships a tagger that writes into archives). ShareAlike applies to what
  *we distribute*; attribution + licence link required (and don't rehost Metron's fair-use cover images).
- **Attribution, no-ads:** **MangaDex** (credit required; not for ad/paid services).
- **Strict:** **AniList** forbids using the API "as a backup or data-storage service" and forbids
  hoarding — fine for lookups + a transient cache, not for mirroring.
- **Risky for us:** **ComicVine** is non-commercial **and** says "do not edit, manipulate or reproduce on
  any other medium" — in direct tension with writing ComicInfo. Treat as opt-in, admin-key,
  clearly-labelled personal use.
- **Books:** **Google Books** forbids permanent copies (cache-header only) — transient only. **ISBNdb** is
  paid with a >1,000-record cap and delete-on-cancel. **Hardcover**: no LLM training, no resale of
  user-owned data, cite. **PRH**: no bulk redistribution. **BookBrainz/Inventaire**: CC0.
- **Jikan/Kitsu:** MAL data / undefined terms — grey, use as best-effort fallbacks.

## Recommended shape (for a later build — not built)

1. **If the admin has Kavita+:** offer to **use it** — detect the licence and surface/trigger
   `/api/Metadata/series-detail-plus` and `/api/Series/match`. Least code, no keys, good Manga/comic/book
   coverage.
2. **Otherwise, provider-specific default, one "Suggest" action per card, with human confirmation:**
   - **Comics:** **Metron primary**, **GCD fallback** (coverage/history); ComicVine optional/admin-key.
   - **Manga:** **MangaDex primary**, **AniList** for light novels / secondary.
   - **Books:** **Hardcover primary**, **Open Library fallback**; **PRH** enrichment for imprint/age.
3. **Always:** single lookup per review (never poll), aggressive local caching, persist provider IDs to
   skip re-search, honour `Retry-After`/rate-limit headers, send a truthful `User-Agent`, proxy images,
   and show **attribution** on the review screen/about page (Metron/GCD/MangaDex/Hardcover).
4. **Reality check:** even a good stack won't fill **Imprint** and **AgeRating** except via PRH
   (or Metron's per-issue rating), and **ISBN** only for books — keep those as manual fields with a
   sensible default.

## Decisions to make next

1. **Kavita+ vs direct providers vs both** (both is likely: prefer Kavita+ when present, direct otherwise).
2. **Which providers to enable by default** and which to keep opt-in (ComicVine is the obvious opt-in;
   recommend **Metron + GCD (comics), MangaDex + AniList (manga), Hardcover + Open Library (books)**).
3. **Key handling:** ship no keys; store admin-supplied keys (Kavita+ needs none; Metron/AniList need
   only a free per-install account/token; Hardcover a free PAT or OAuth). Decide where keys live
   (encrypted in the portal DB like sessions, or `.env`).
4. **Legal review** before enabling ComicVine or persisting Google Books data.
5. **Attribution UX:** where the "metadata from X, CC BY-SA 4.0" credit lives.
6. **Scope/phasing:** do we want phase-2 now, or is phase 1 (existing-series suggestions) enough for a
   while?
