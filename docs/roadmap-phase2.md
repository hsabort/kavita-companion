# Phase 2 — Direct metadata integration (plan)

A concrete plan to integrate kavita-companion **directly** with external metadata providers and write the
fetched values into users' files (ComicInfo.xml for comics, EPUB OPF for books), so the library Kavita
serves becomes **clean, searchable and browsable** — **without violating any provider's licence or Terms
of Service**. This is a plan; nothing here is built.

**Status:** **M1 shipped in 0.3.0** — the provider framework (W1), the Metron comics adapter (W2) and the
review card's Find metadata/apply + attribution (W8), with the fake-provider test scaffolding (W11).
**M2 shipped in 0.3.1**: the GCD comics fallback (W3). **M3 shipped in 0.4.0 (W4/W5)**: the MangaDex
manga adapter and the AniList manga/light-novel fallback, both keyless and off by default, with their
fake-provider tests. **M4 built (W6/W7)**: the Hardcover book adapter (keyed) and the Open Library book
fallback (keyless), with their fake-provider tests; **PRH is deferred** (an opt-in follow-up, the only
source of a true Imprint/AgeRating). **M5 built (W9, Unreleased)**: the reviewer-only **Library** view —
browse/search and the "needs metadata" queue over Kavita's own catalogue; per-series bulk-fill and
saved views are deferred. **M6 (compliance polish, Unreleased)**: the compliance measures are documented
in [compliance.md](compliance.md) and the **no-bulk / per-review safeguard is a fast-tier test**
(`tests/test_providers_safeguard.py`); no legal pass is required to ship (see the Decisions below).

Integration is **direct** (no Kavita+ dependency), **human-reviewed**, **low-volume and cached**. Every
provider must pass the Compliance gate (section 1) before it can be enabled; a provider that cannot be
used safely is excluded or shipped off by default. Section 5 assigns the work to named agent roles with
estimates.

## Status (updated 2026-10-16)

**W1 — provider-adapter framework — is built** (branch `feat/phase2-w1`): the adapter contract
(`src/providers/types.ts`), registry with enable/key resolution, the shared outbound HTTP client
(timeout, retries/backoff, `Retry-After`, token bucket, UA, size cap, HTML strip), AES-256-GCM key
storage in `provider_config`, the `metadata_cache`/`provider_links` tables, `merge.ts`, the reviewer-only
`/api/admin/providers` routes, and a test-only stub provider plus the fake-provider harness
(`tests/provider_fake.py`, `tests/test_providers_framework.py`). External metadata is **off by default**;
no provider-specific adapter (Metron, GCD, MangaDex, …) is built yet. See
[architecture.md](architecture.md#metadata-providers-phase-2).

**W9 — search & browse (M5) — is built** (branch `feat/phase2-library`): a completeness signal per
series and a reviewer-only **Library** tab with browse/search and a "needs metadata" queue, read-only
over Kavita's own APIs (`src/library.ts`, `docs/architecture.md#library-view-phase-2-m5`). Per-series
bulk-fill, saved views and sort-by-completeness are deferred (decision 6).

## Defaults we intend to ship

| Media | Primary | Fallback | Opt-in / excluded |
|---|---|---|---|
| Comics | **Metron** (CC BY-SA 4.0) | **GCD** (CC BY-SA 4.0) | **ComicVine** = opt-in only (non-commercial, admin key) |
| Manga / light novels | **MangaDex** | **AniList** | Jikan/Kitsu = excluded (grey / undefined terms) |
| Books | **Hardcover** | **Open Library** | **PRH** = opt-in (imprint/age); **Google Books** = transient only; **ISBNdb** = excluded (paid) |

External lookups are **off by default**: an admin turns a provider on and supplies any key/token it needs.

## Non-negotiables (every section assumes these)

- **One lookup per human review; never poll or bulk-mirror.** Aggressive local cache with per-provider TTL.
- **The reviewer confirms every field; nothing is auto-applied.** Values the file already has (or that are
  locked) are never overwritten silently.
- **Attribution** shown wherever provider data appears; **`Retry-After`/rate limits honoured**; truthful
  `User-Agent`; cover images proxied only where the licence allows (never rehost Metron/ComicVine covers).
- **No shipped keys;** admin-supplied and stored encrypted; **provider IDs persisted** to avoid re-searching.

## How this plan is organised

1. **Compliance & provider terms** — per-provider obligations, the concrete safeguards we implement, the
   allow / opt-in / exclude classification, and a pre-flight checklist.
2. **Architecture** — the provider-adapter interface, field mapping and merge/precedence, the data model,
   the HTTP/key layer, and how it plugs into the existing review/requests/notifications flow.
3. **Search & browse** — what "clean" means, a completeness score and "needs metadata" queue, and a thin,
   reviewer-only companion **Library** view built on Kavita's own search/filter APIs.
4. **QA / test plan** — an in-process fake-provider server with recorded fixtures so adapters are tested
   with no network, no keys, and in the fast tier; a target fast-tier budget.
5. **Project plan** — agent roles, work packages with person-day estimates, dependencies, milestones,
   RACI, risks and per-milestone definition of done.

## Owner decisions (resolved 2026-10-16)

**See [Decisions](#decisions-agreed-2026-10-16) below.** The open questions were: (1) Kavita+ vs
direct vs both; (2) provider enable-match defaults; (3) key storage (`.env` vs encrypted DB); (4)
ComicVine and any persistence of Google Books data — **legal pass**; (5) attribution copy; (6) the scope
of search & browse. **Compliance holds a veto on enabling any provider.** Six direct providers are now
built (Metron, GCD, MangaDex, AniList, Hardcover, Open Library); the decisions settled the rest.

---

---

## Decisions (agreed 2026-10-16)

These supersede the open questions in the sections below.

1. **Direct integration only** — no Kavita+ dependency; we don't reimplement Kavita's own matching. (Kavita+ users keep Kavita's matching inside Kavita.)
2. **Providers enabled by default** when an admin turns external metadata on: comics **Metron → GCD**, manga/LN **MangaDex → AniList**, books **Hardcover → Open Library**; **ComicVine and PRH opt-in**; **Jikan, Kitsu, ISBNdb excluded**. External lookups are off until enabled.
3. **Keys** are stored **AES-256-GCM-encrypted in SQLite** (`COMPANION_SECRET`), managed by admins in the portal, with an optional `.env` override.
4. **ComicVine and Google Books are excluded** — their terms conflict with writing data into files. No legal pass is required to ship phase 2.
5. **Attribution:** per-candidate source chips + an "applied from X (CC BY-SA 4.0)" line on the card + an **About → Metadata sources** page listing each provider's credit and licence link, rendered from adapter metadata.
6. **Search & browse:** a metadata-completeness score + a **"needs metadata" queue** + a thin reviewer-only **Library** tab (search/filter/browse that feeds the fix flow); per-series bulk-fill and saved views are deferred. PRH stays opt-in (the only true imprint/age source).

**Consequences for the sections below:** the Kavita+ delegation path (architecture §5; project §3/§4) is **out of scope**; the ComicVine adapter and the legal-pass gate (compliance §3; project §4/§5) are **dropped**; PRH remains opt-in; no legal sign-off is needed to ship.

**Reconciliation:** everything below this line is the original plan, kept for history. Where a section
still describes **Kavita+ delegation as a preferred path**, **ComicVine / Google Books as opt-in or
"legal pass required"**, the **legal-pass gate**, or a **built PRH adapter**, these decisions win:
Kavita+ is out of scope (decision 1), ComicVine and Google Books are **excluded** (decision 4), the
legal-pass gate is dropped (no legal sign-off is needed to ship), and PRH is **deferred**, not built
(decision 6). The shipped, current description lives in
[docs/metadata-providers.md](metadata-providers.md), [docs/compliance.md](compliance.md) and
[architecture.md](architecture.md#metadata-providers-phase-2).

---

# 01 — Compliance and provider terms

Scope: **kavita-companion** integrates directly with third-party metadata providers and writes the
fetched data into users' own files (ComicInfo.xml for comics, EPUB OPF for books). This section states,
per provider, the exact obligations and prohibitions that apply; the measures the software must
implement to satisfy them; an allow / opt-in / exclude classification with the default we ship; and a
pre-flight checklist per provider.

**Hard constraint.** We must not violate any provider's licence or Terms of Service. Where a provider's
terms are incompatible with "fetch here and write into a user's file", the provider is excluded or
gated behind an explicit, labelled, admin-supplied-key opt-in — never enabled by default.

**Not legal advice.** This is an engineering reading of the providers' published terms as captured in
`docs/metadata-providers.md` and `docs/research/R1–R4` on 2026-10-16. Terms change. Every enable is
preceded by the checklist in §4, and the app must carry the same disclaimer (§2, M11).

---

## 1. Per-provider obligations and prohibitions

For each provider: what we may do, what we must do, what we must not do, with the rule cited.

### 1.1 Metron — comics (allow; admin supplies a free per-install token)

Documentation: Metron API `https://metron.cloud/api/`, policy at `https://metron.cloud/`.

- **Licence.** Content is **CC BY-SA 4.0** (`https://creativecommons.org/licenses/by-sa/4.0/`).
  Commercial use and embedding are **explicitly allowed**; the official `metron-tagger` writes metadata
  into comic archives, so writing ComicInfo is an *intended* use.
- **Attribution (must).** Required: credit "Comic data from Metron, CC BY-SA 4.0" with a link to the
  licence. Attribution must accompany any display or redistribution of the data.
- **ShareAlike (must understand).** ShareAlike attaches to **adaptations we distribute**. The portal is
  self-hosted and does not publish its users' files, so a private instance writing into its own files
  does not trigger a public distribution obligation — but **any feature that exports, shares or ships
  fetched data must attach the attribution and the CC BY-SA 4.0 notice, and be licensed CC BY-SA 4.0**.
  The Apache-2.0 code and the CC BY-SA 4.0 data coexist: the code does not become CC BY-SA, and the
  ShareAlike obligation attaches only to adaptations of the data, not to the portal as a whole. (This
  note previously cited GPL-3.0 ↔ CC BY-SA 4.0 compatibility; that declaration was specific to
  GPL-3.0, so re-check the pairing before shipping a feature that embeds provider data in a file we
  distribute.)
- **Cover images (must not).** Metron's **cover images are excluded from the CC BY-SA licence**
  (fair use). Do **not rehost, proxy-cache to disk, or write them into files**. Fetch none; show the
  local file's own cover instead.
- **Accounts (must).** Metron's policy requires **each user to have their own account**; a multi-user
  deployment must not share one account/token across users. Ship **no token**; each install creates its
  own free account and revocable, non-expiring bearer token.
- **Caching (may, and encouraged).** Caching and `modified_gt` incremental sync are explicitly
  encouraged.
- **Rate limits (must honour).** Burst **20/min** + sustained **5,000/day** (donors up to 25,000/day).
  Headers `X-RateLimit-Burst-*` / `X-RateLimit-Sustained-*`, `429` with `Retry-After`.
- **Cross-IDs.** `cv_id` / `gcd_id` are returned; persist them (§2, M3) to reduce lookups.

### 1.2 Grand Comics Database (GCD) — comics (allow; no key)

Documentation: `https://www.comics.org/api/`.

- **Licence.** Content is **CC BY-SA 4.0**; **commercial use allowed**; **attribution required**;
  **ShareAlike on distributed adaptations** (same reasoning as Metron §1.1: private self-hosted use is
  fine; exports/redistribution carry attribution + CC BY-SA).
- **Attribution (must).** Credit "Comic data from the Grand Comics Database (GCD), CC BY-SA 4.0".
- **Cover images.** The `current.zip` **bulk dumps are offered** and are CC BY-SA data — importing them
  locally (attributed) is permitted, unlike AniList/Google/ComicVine. Cover *art* remains the rights
  holder's; do not redistribute cover images.
- **Rate limits (must honour).** Anonymous **30/hour**; authenticated free account **2,000/day**; page
  size **50**; bulk dumps have a **5-minute cooldown**.
- **Bulk.** The full dump is allowed **locally** under CC BY-SA with attribution (§2, M3, M9). Do not
  publish the dump.

### 1.3 MangaDex — manga (allow; no key, server-side only)

Documentation: `https://api.mangadex.org/docs/`.

- **Credit (must).** "MUST credit MangaDex." A visible credit is required wherever MangaDex data is
  shown, plus the attribution screen.
- **No ads / no paid service (must not).** MangaDex data may not be used to run **ads or a paid
  service**; the project's intent is non-profit and donations are fine. The portal must stay ad-free
  and must not gate MangaDex-derived metadata behind a fee.
- **Truthful User-Agent (must).** A truthful, identifying `User-Agent` is **mandatory**; never spoof a
  browser.
- **Server-side proxy (must).** The API has **no CORS for third parties**, so browser calls are not
  allowed: all requests go through the portal server. **Images may not be hotlinked** — proxy them
  (§2, M7).
- **Rate limits (must honour).** ~**5 requests/s per IP**; `429`; **persistent abuse → temporary 403
  ban**. `offset + size ≤ 10,000`; `size ≤ 100` (typical).
- **Caching (expected).** `Cache-Control` is present and caching is expected (§2, M3).

### 1.4 AniList — manga + light novels (allow; no key, strictest terms)

Documentation: `https://anilist.gitbook.io/anilist-apiv2-docs/`.

- **No data-storage / no hoarding (must not).** AniList's terms forbid using the API **"as a backup or
  data-storage service"** and forbid **hoarding / mass collection**. The data may **not** be mirrored,
  bulk-fetched, or treated as a system of record. It may not be used to build a competing tracker from
  AniList data.
- **What is fine (must stay within).** **Tens of lookups/day plus a transient, bounded cache** is
  acceptable. So: per-review lookup only, short TTL, hard row cap, scheduled purge (§2, M3, M4).
- **Commercial licence (must monitor).** Free for non-commercial; a **commercial licence is required
  only above $150/month revenue**. The project must not charge for AniList-derived metadata, and this
  threshold must be re-checked if the project ever monetises.
- **Attribution/naming (must).** Follow AniList's naming/attribution rules; credit AniList.
- **Rate limits (must honour).** Documented **90/min, currently degraded to 30/min** (live
  `X-RateLimit-Limit: 30`) plus a **burst limiter**; `429` with `Retry-After`. **No paid tier** to
  raise it.
- **No key.** Reads need no auth; OAuth only for private/mutations (we never mutate).

### 1.5 Hardcover — books, manga, light novels (allow; free per-install PAT)

Documentation: `https://hardcover.app/account/api`.

- **No LLM training (must not).** Hardcover's terms forbid using their data **for LLM training**.
  Provider payloads must never be sent to, or used to train, an LLM; the app must not embed an LLM path
  over Hardcover data.
- **No use of user-owned data (must not).** **Commercial/public products may not use user-owned data**;
  we use the public catalogue only. Aggregate data may be shown **with attribution**.
- **Attribution (must).** Cite Hardcover wherever its data is displayed.
- **Images (must).** Image use requires a **DMCA policy**; if we display Hardcover images, the app must
  expose an abuse/DMCA contact. Simplest compliant default: do not persist or redistribute their
  images (§2, M7).
- **Tokens (must).** **Personal Access Tokens are per account** (free, scoped, expiring); OAuth is for
  multi-user apps. Ship no token; each install uses its own PAT. Never bundle a shared token.
- **Rate limits (must honour).** Free **5,000/day, 60/min, burst 10** (Supporter 50,000/day, burst 15);
  **each top-level field counts as a request**; **30 s query timeout** (search 2 s); `RateLimit` /
  `Retry-After` headers. Budget accordingly — a fat GraphQL selection is many "requests".
- **Beta.** Treat fields as unstable; never overwrite a manually entered value with a lower-confidence
  one.

### 1.6 Open Library / Internet Archive — books (allow; no key)

Documentation: `https://openlibrary.org/developers/api`.

- **IA rights position (must reflect).** IA **"does not assert any new copyright"** and warns there may
  be **existing rights issues**; IA Terms apply. We assert no ownership and pass records through.
- **Identification (must).** No key, but identify with a **User-Agent + contact email** to get the
  higher limit. A generic/browser UA is not acceptable behaviour.
- **Rate limits (must honour).** **1 request/s** anonymous, **3/s** identified; **"not intended as a
  data backend"** — no scraping; use the **monthly dumps** for anything bulk.
- **Caching (allowed).** Caching is friendly, especially when identified.

### 1.7 Penguin Random House (PRH) — books, PRH imprints only (opt-in)

Documentation: `https://developer.penguinrandomhouse.com`.

- **Scope (must).** PRH-owned/distributed imprints **only**; useless and possibly misleading outside
  that catalogue. Use only as ISBN-keyed enrichment when the title matches a PRH imprint.
- **No bulk redistribution (must not).** PRH's terms are not published on the dev site; assume **no
  bulk redistribution** of its data or covers.
- **Key (must).** Free registration but keys require **manual activation** (hours to 7+ days). Per
  install, admin-supplied, never shipped.
- **Rate limits (must honour).** None published — be polite; use the same shared limiter (§2, M5).
- **Why opt-in.** It is the **only** source for a true **Imprint** and a real **AgeRating** proxy
  (age/grade) plus BISAC genres and `seriesNumber`, so it is worth offering — but only for PRH titles
  and only when an admin owns a key.

### 1.8 ComicVine — comics (OPT-IN ONLY, explicitly labelled non-commercial; default excluded)

Documentation: `https://comicvine.gamespot.com/api/documentation`.

- **Non-commercial (must not).** **Non-commercial only**: "Commercial use will result in your API key
  being revoked." The portal must present this as personal, non-commercial use.
- **No reproduction on any other medium (must not).** Terms say **"Do not edit, manipulate or
  reproduce on any other medium."** Writing ComicInfo is in **direct tension** with this, which is why
  this is the riskiest provider for us.
- **Competing product (must not).** Do not build a competing product from the data.
- **Credit + link (must).** Credit and link back to ComicVine.
- **Revocable (must plan).** The key is revocable at any time; the app must degrade gracefully.
- **Rate limits (must honour).** **200 requests per resource per hour** plus velocity detection;
  `limit ≤ 100`, search `≤ 10`. Cache aggressively.
- **Classification.** **Excluded by default.** May be enabled **only** by an admin who supplies their
  own key and ticks a labelled acknowledgement ("personal, non-commercial use; not legal advice; review
  the current ComicVine terms first"). Never ship a key; never enable it silently.

### 1.9 Providers we classify as excluded (with reasons)

- **Google Books** — ToS forbids **permanent copies** and caching beyond the cache header; **no
  redistribution**; ~1,000/day. Transient-only is too restrictive to be useful and easy to violate:
  **exclude by default**; if ever added, transient cache only and a legal review.
- **Jikan** (unofficial MAL) — data is MAL's, scraped; MAL ToS prohibits automated collection; no clean
  data licence. **Exclude** (grey).
- **Kitsu** — no data licence stated (assume all-rights-reserved). **Exclude**.
- **ISBNdb** — paid, **>1,000-record cap**, **delete-on-cancel**. **Exclude** unless deep
  out-of-print/non-English is needed; if added, must delete data within 30 days of termination.
- **BookBrainz / Inventaire** — CC0 and clean, but thin/alpha. **Exclude / optional**; only if we want
  licence-clean backfills, with attribution where their non-CC0 parts apply.
- **Kavita+** — not a provider integration; the alternative that offloads provider obligations to
  Kavita's backend (no keys, $4/mo, node-locked). It remains the recommended option when the admin
  already pays, and it is **outside** this section's write-path compliance surface.

---

## 2. Measures the software must implement

Each measure maps to the rules above. Names are proposals to reconcile with the config/DB sections of
this plan.

**M1 — Single provider registry (source of truth).** One registry (`src/providers/registry.ts`) where
each provider declares: `id`, display name, fields, licence id + link, attribution string,
`attributionRequired`, default state (`allow` | `optin` | `exclude`), key/account requirement, cache TTL
and storage mode, rate limits, image policy, and redistribution rules. The attribution screen, cache
policy, limiter and enable-gate all read from this one place so a licence change is a one-line edit.

**M2 — Attribution and licences screen.** A portal screen ("About → Data sources" / "Metadata
sources") that lists **only the providers actually enabled**, each with its **full licence/terms text
and live links**, generated from the registry. Plus a short credit on the review card wherever a
provider's data is shown (e.g. "Data from Metron · CC BY-SA 4.0"). Required strings:
- Metron: "Comic data from Metron, CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/"
- GCD: "Comic data from the Grand Comics Database (GCD), CC BY-SA 4.0"
- MangaDex: "Manga data from MangaDex" (no ads/fees)
- AniList: "Manga/LN data from AniList"
- Hardcover: "Book data from Hardcover"
- Open Library / Internet Archive: "Book data from Open Library (Internet Archive); IA asserts no new
  rights; existing rights may apply"
- PRH: "Book data from Penguin Random House"
- ComicVine (if enabled): "Comic data from ComicVine — personal, non-commercial use"
Mirror the same credits into `NOTICE.md` and `docs/` since those *are* redistributed.

**M3 — Caching policy (what may be stored, how long, where).** New `metadata_cache` table in
`companion.db` (provider, cache key, JSON payload, `fetched_at`, `expires_at`) plus persisted provider
IDs on the upload/record (`metron_id`, `gcd_id`, `mangadex_id`, `anilist_id`, `hardcover_id`,
`openlibrary_id`, `prh_isbn`) so re-search is avoided. Per-provider policy:

| Provider | May store | TTL | Caps / notes |
|---|---|---|---|
| Metron | lookup JSON + IDs; cache encouraged | 30 d | no cover images |
| GCD | JSON, IDs; optional **local** bulk dump | 30 d | dump stays local, attributed |
| MangaDex | response JSON, honour `Cache-Control`/ETag | 24 h default | no images on disk |
| AniList | **transient only** | ≤ 24–72 h | **hard cap** (e.g. ≤ 5,000 rows) + scheduled purge; never a system of record |
| Hardcover | lookup JSON + IDs | 7–30 d | per-account token |
| Open Library | lookup JSON + IDs | 30 d | identified UA+email |
| PRH | lookup JSON + IDs (PRH only) | 30 d | no covers |
| ComicVine (opt-in) | JSON, cache aggressively | 30 d | non-commercial |

Store under `DATA_ROOT/companion/` (DB or `cache/`), never inside library folders. All caches are
purged on provider disable and on expiry.

**M4 — "No bulk mirror / no hoarding" safeguard.** External lookups are **per-review, admin-triggered
only**: one "Suggest" action per review card. **No background crawler, no scheduled bulk refresh, no
auto-fetch on upload, no related-series fan-out.** A hard per-install daily lookup budget stops calls
when exhausted. AniList has this most strictly (M1.4): the **bulk path is simply not implemented**, not
merely configured off. Every external call is recorded in `audit_log`.

**M5 — Rate limits and `Retry-After`.** One shared outbound queue with a per-provider token bucket
seeded from the registry: Metron 20/min + 5,000/day; GCD 30/hr anon or 2,000/day auth (page 50);
MangaDex ~5/s/IP; AniList 30/min + burst; Hardcover 60/min + 5,000/day; Open Library 1/s (3/s
identified); PRH polite; ComicVine 200/resource/hr. **Honour `X-RateLimit-*`, `RateLimit` and `429
Retry-After`**: never retry immediately, use exponential backoff, trip a circuit breaker, and surface a
"provider unavailable, try later" state (never block approval). Deduplicate concurrent identical
lookups (single-flight). Short timeouts and response-size caps, as `src/notify.ts` already does.

**M6 — Truthful User-Agent and contact.** One shared, honest UA, e.g.
`kavita-companion/<version> (+<PUBLIC_ORIGIN>; metadata lookup; admin-configured)`, with a configurable
contact email for Open Library's identified tier. Never spoof a browser or `curl`. MangaDex treats the
UA as mandatory.

**M7 — Image proxy rules.** Provider cover images pass through a **server-side proxy** (CSP is already
`img-src 'self' blob: data:`) that only **streams**: no disk persistence, no writing into user files or
exports, no redistribution. MangaDex **requires** proxying (no hotlinking). **Metron, PRH and (by
default) ComicVine images are not fetched at all.** Send conditional requests (`If-None-Match`),
honour `Cache-Control`, and abort on `304`.

**M8 — Keys and accounts.** **Ship no keys.** `.env.example` lists them empty. Keys are **per-install,
admin-supplied**, and free per-install accounts are the norm (Metron account/token, Hardcover PAT, PRH
key); AniList and MangaDex need none. **One account/token per install — never a shared/bundled
token** (Metron explicitly forbids shared accounts). Store provider secrets in `.env`
(mode 600, git-ignored, per `docs/security.md`) alongside `COMPANION_KAVITA_AUTH_KEY`, **or** encrypted
in `companion.db` with `COMPANION_SECRET` (AES-256-GCM, as sessions already do); **never log them**
(redact like the sidebar key) and never render them back in the admin UI (write-only field).

**M9 — Distribution of fetched data.** The portal must not redistribute provider data. Any feature that
exports, shares or ships data (sample data, test fixtures, support/backup bundles) must either strip
provider payloads or attach the provider's attribution and, for Metron/GCD, the **CC BY-SA 4.0 notice
and licence**. **Test fixtures use synthetic data, never real provider responses.** Backups contain the
cache and are private (never published).

**M10 — Enable gate, audit and kill switch.** External metadata is **off entirely by default**
(`METADATA_EXTERNAL_ENABLED=false`). Enabling a provider requires an admin action that shows the
licence, requires an explicit acknowledgement, and writes a config row plus an `audit_log` entry. A
kill switch (empty provider list / env) disables every external call, and the "Data sources" page
always shows what is enabled.

**M11 — "Not legal advice" note.** A persistent note in the enable flow, the "Data sources" page,
`README.md`/`docs/`, and this plan: *"This is not legal advice. Provider terms and licences change;
re-check them before enabling. ComicVine in particular is non-commercial and restricts reproduction;
enabling it is the admin's decision and responsibility."*

**M12 — Non-commercial posture.** Keep the portal free and ad-free (MangaDex and AniList both rely on
this). Record the AniList **$150/month revenue** threshold as the trigger for a commercial licence, and
never charge for AniList/MangaDex-derived data.

---

## 3. Allow / opt-in / exclude, and the default we ship

| Provider | Class | Reason | Key |
|---|---|---|---|
| Metron | **Allow** | CC BY-SA 4.0, commercial OK, embedding intended; per-install free token | token (admin) |
| GCD | **Allow** | CC BY-SA 4.0, commercial OK, no key; best historical/non-US | none |
| MangaDex | **Allow** | Free, no key, attribution + no-ads are satisfiable | none |
| AniList | **Allow** (strict) | Free, no key; transient cache + no bulk satisfies no-hoarding | none |
| Hardcover | **Allow** | Free PAT; series/volume + genres; no-LLM/no-user-data are satisfiable | PAT (admin) |
| Open Library | **Allow** | Free, no key, attribution-neutral; needs identified UA | none |
| PRH | **Opt-in** | Only true Imprint + AgeRating, but PRH-only, manual key, no bulk redistribution | key (admin) |
| ComicVine | **Opt-in** (labelled, default excluded) | Non-commercial + "no reproduce on any other medium" conflicts with writing files | key (admin) + ack |
| Google Books | **Exclude** | Forbids permanent copies; no redistribution | — |
| Jikan | **Exclude** | MAL data, no clean licence; MAL prohibits automated collection | — |
| Kitsu | **Exclude** | No data licence (all rights reserved) | — |
| ISBNdb | **Exclude** | Paid, >1,000-record cap, delete-on-cancel | — |
| BookBrainz / Inventaire | **Exclude / optional** | CC0 but thin/alpha | — |

**Default configuration to ship** (external metadata off until an admin turns it on):

- `METADATA_EXTERNAL_ENABLED=false` — nothing is fetched by default.
- When enabled, per library type: **comics → Metron, GCD**; **manga/LN → MangaDex, AniList**;
  **books → Hardcover, Open Library**.
- **Opt-in, off unless explicitly set:** `METADATA_ENABLE_PRH=false` (+ `METADATA_PRH_KEY`),
  `METADATA_ENABLE_COMICVINE=false` (+ `METADATA_COMICVINE_KEY` + acknowledgement flag).
- **Secrets, always empty in `.env.example`:** `METADATA_METRON_TOKEN`, `METADATA_HARDCOVER_TOKEN`,
  `METADATA_PRH_KEY`, `METADATA_COMICVINE_KEY`; plus `METADATA_CONTACT_EMAIL` (Open Library /
  User-Agent).
- **Limits:** `METADATA_CACHE_TTL_HOURS` (per-provider overrides in the registry),
  `METADATA_DAILY_LOOKUP_BUDGET`.
- External providers are **not** enabled by default **even for "allow"** providers, because they add
  outbound calls and ToS obligations; the *classification* is allow, the *shipped default* is off until
  an admin opts in with an acknowledgement.

---

## 4. Pre-flight checklist before enabling each provider

Run the generic list, then the provider's own items. Record the date and the reviewer.

**Generic (every provider):**
1. Re-read the provider's current ToS/licence page; confirm the link in the registry is live.
2. Confirm the classification still holds (allow / opt-in / exclude) and that attribution text is
   present on the review screen and the "Data sources" page.
3. Confirm the rate-limit config matches the documented limits and `Retry-After` is honoured.
4. Confirm the cache policy (TTL, caps, storage location, purge) matches §2, M3 — especially for
   AniList and Google Books.
5. Confirm no key/token is shipped and the admin-supplied value is stored per §2, M8 and never logged.
6. Confirm no bulk path exists for this provider (M4) and lookups are admin-triggered only.
7. Confirm no provider images are written to files or exports (M7).

**Metron:** free per-install token created and stored; cover images confirmed not fetched; 20/min +
5,000/day limits set; attribution "Comic data from Metron, CC BY-SA 4.0" live.
**GCD:** 30/hr anon vs 2,000/day auth chosen; page size 50; if importing the bulk dump, keep it local
with the CC BY-SA attribution file; attribution live.
**MangaDex:** truthful User-Agent; all calls server-side (no browser/CORS); images proxied, not
hotlinked; no ads/paid features touch MangaDex data; ~5/s limit set.
**AniList:** transient cache only, TTL ≤ 72 h, hard row cap + scheduled purge; no bulk/mirror code
path; keep a written note that the $150/month commercial threshold applies; 30/min limit set.
**Hardcover:** per-install PAT; no LLM path and no user-owned data use; per-field request budget
accounted for; images not persisted; attribution live; 60/min + 5,000/day set.
**Open Library:** identified User-Agent + contact email configured; 1/s (3/s identified) limit set; no
scraping; attribution/IA note live.
**PRH:** key manually activated; only PRH imprints queried; no covers/bulk redistribution; polite
limiter; "not legal advice" note shown.
**ComicVine (opt-in only):** legal review recorded; admin key supplied by the admin; explicit
non-commercial acknowledgement captured; 200/resource/hour limit set; graceful revocation handling;
cache aggressive; labelled in the UI and in `docs/decisions.md`.

---

# 2. Architecture — direct provider integration with file writes

Scope: **phase 2 of roadmap §5**. Phase 1 (already shipped) reads the matching series' own metadata
out of Kavita in `review.ts` (`suggestFor` + `GET /api/review/:id/suggest`) and offers it as a
one-click fill on the review card. This section adds **direct, admin-triggered, cached lookups** to
third-party providers and merges their fields with phase 1's so the reviewed file's ComicInfo.xml /
EPUB OPF can be filled before approval. It never touches a file that is not under review, and it never
runs in bulk (one lookup per human action).

Chosen set (from `docs/metadata-providers.md`, decision 2): **Metron + GCD** (comics),
**MangaDex + AniList** (manga / light novels), **Hardcover + Open Library** (books); **PRH** optional
enrichment (deferred, not built); **ComicVine** opt-in behind an explicit legal acknowledgement.
**Superseded by decision 1:** **Kavita+ (R4) is out of scope** — the Kavita+ delegation path below is
*not* built; the portal integrates directly and leaves Kavita's own matching to Kavita.

---

## 2.1 Provider-adapter abstraction, registry, ranking, confirmation

### Modules

New directory `kavita-companion/src/providers/`:

| File | Responsibility |
|---|---|
| `types.ts` | `MediaClass`, `SearchQuery`, `Candidate`, `FetchedRecord`, `ProviderAdapter`, `ProviderDescriptor` |
| `registry.ts` | The list of adapters, enable/configured resolution, media-class → ordered adapters, `kavitaplus` preference |
| `http.ts` | `providerFetch()`: UA, timeouts, retries/backoff, per-provider token bucket, `Retry-After`/`X-RateLimit-*`, size caps |
| `graphql.ts` | GraphQL POST helper (AniList, Hardcover): error-in-200 handling, variable-safe query building |
| `match.ts` | `rank(query, candidates)` scoring and `confidence` banding; `normalizeTitle`/`normalizeNumber` |
| `merge.ts` | Field mapping result → our `Metadata`, per-field precedence, lock/known-good rules, provenance |
| `cache.ts` | `metadata_cache` read-through, TTL policy, purge, "refresh" bypass |
| `links.ts` | `provider_links` read/write, cross-ID reconciliation, series-identity helper |
| `metron.ts`, `gcd.ts`, `mangadex.ts`, `anilist.ts`, `hardcover.ts`, `openlibrary.ts`, `prh.ts`, `comicvine.ts`, `kavitaplus.ts` | One adapter each |

Adapters only talk to *fixed, hard-coded HTTPS base URLs* (never a user-supplied host), so unlike
`notify.ts` there is no user-controlled SSRF target; `http.ts` still pins the host per adapter and
refuses redirects to another host.

### The interface

Every adapter implements the same two-step contract:

- `descriptor`: `id`, display `name`, `media: MediaClass[]`, `requiresKey`, `defaultEnabled`,
  `attribution` (e.g. `Comic data from Metron, CC BY-SA 4.0`), `licence`, `homepage`,
  `recordTtlMs`, `searchTtlMs`, `minIntervalMs`.
- `isConfigured()`: key/licence present (for keyed providers), otherwise true.
- `search(query, signal) → Candidate[]`: cheap, relevance-ranked candidates only.
- `fetch(externalId, signal) → FetchedRecord`: full field set for one confirmed hit.

`SearchQuery` fields: `media`, `series`, `number`, `volume`, `year`, `publisher`, `imprint`, `title`,
`isbn`, `language`, plus `preferredNumber` for per-file fetch. `Candidate` fields: `provider`,
`externalId`, `seriesTitle`, `number`, `volume`, `title`, `year`, `publisher`, `imprint`, `isbn`,
`coverUrl` (never hotlinked), `score`, `confidence`, `sourceUrl`. `FetchedRecord` fields: `provider`,
`externalId`, already-**mapped `Metadata`** (our ComicInfo field names, so `merge.ts` never needs
per-provider code), `rawRef` (cross-IDs for `provider_links`: `metronId`, `gcdId`, `cvId`, `malId`,
`aniListId`, `hardcoverId`, `isbn`), optional `coverUrl`, `attribution`, `licence`, `sourceUrl`,
`fetchedAt`.

What each adapter returns (search shape → fetch shape, from `docs/research/*.md`):

| Provider | Search call | Fetch gives |
|---|---|---|
| `metron` | `/api/issue/?series_name=&number=&series_year_began=` (one request) | Series/Number/Volume, Title, Summary, Year, all five creator roles, Publisher, Imprint, Genre, Tags, LanguageISO, AgeRating, ISBN (issue), cover |
| `gcd` | `/api/series/name/<n>/issue/<n>/year/<y>/` (list → issue detail) | Series/Number/Volume(free text), Title, Summary, Year, Writer/Penciller/Inker/Colorist/CoverArtist (free-text, parsed), Publisher, Imprint(brand_emblem), Genre, Tags, AgeRating |
| `mangadex` | `/manga?title=&year=&authors[]=` | Series (title+altTitles), Number/Volume (lastChapter/lastVolume), Title, Summary, Year, Writer(author), Penciller(artist), Genre, Tags, LanguageISO, AgeRating (contentRating mapped), cover (proxy) |
| `anilist` | GraphQL `Media(search,type:MANGA)` | Title, Summary (`asHtml:false`), Year, Writer (staff edges), Genre, Tags, LanguageISO (countryOfOrigin mapped), AgeRating (`isAdult`, coarse) |
| `hardcover` | GraphQL Typesense `search(query_type:book/series)` | Series, Volume/Number (featured_series_position), Title, Summary, Year, Writer(author_names), Publisher(edition), Genre, Tags/moods, LanguageISO, ISBN — best Series/Volume source |
| `openlibrary` | `/search.json?q=` then `/works`+`/books` | Title, Summary, Year, Writer, Publisher, Genre/Tags(subjects), LanguageISO (MARC→ISO), ISBN; Series/Volume partial |
| `prh` (opt-in) | ISBN-keyed `/titles/{isbn}` | Publisher, **Imprint**, Genre (BISAC), LanguageISO, **AgeRating** (age/grade), Series/Number(seriesNumber), ISBN — PRH titles only |
| `comicvine` (opt-in) | volume→issue two-step | Series/Number/Title/Summary/Year/creator roles/Publisher/Volume(start_year) |
| `kavitaplus` | (delegated) `POST /api/Series/match` | Reads `GET /api/Metadata/series-detail-plus` + `/api/Series/metadata`; needs the series already in Kavita |

### Ranking and disambiguation

`match.ts` scores every candidate against the `SearchQuery` with weighted signals (weights are
constants in one table, tuned by tests):

- normalised **series title equality** (large positive); token-prefix/substring is a small positive,
  not equality.
- **number** exact match (`normalizeNumber` strips `#`, leading zeros, roman numerals) — decisive for
  comics/issues; negligible for books. A comic whose number is absent is a weak candidate.
- **year** exact (+), ±1 (small +), far (± negative).
- **publisher/imprint** equality (+) — the main disambiguator between same-named series.
- **volume** equality (+); **media/format** agreement (NOVEL vs MANGA, Book vs LN) required, mismatch
  rejected.
- **cross-ID boost**: if the candidate exposes a cross-ID that matches a `provider_links` row we
  already hold (e.g. Metron's `gcd_id`, MangaDex's `links.mal`), score strongly.

Candidates are sorted descending and banded `exact` (title+number+year/publisher agree), `near`
(title agrees, one secondary field differs), or `loose`. Only `exact`/`near` are surfaced by default;
the UI shows up to **5** candidates with cover thumbnail, title, number/volume, year, publisher, and a
provider badge + attribution. `/match` returns them per enabled/configured provider plus a
`providers` list marking which were skipped (disabled, unconfigured, or cooling down after a 429), so a
blank result is explainable.

**A human always confirms.** Nothing is auto-applied and no candidate is auto-fetched: `/match`
returns candidates, the reviewer picks one, and only then does `/apply` call `fetch()`. For a review
group (many files in one series), the reviewer confirms the series once; `/apply` then fetches per
number in the group.

---

## 2.2 Field mapping to ComicInfo / OPF and the merge strategy

`merge.ts` expresses two things: **how each provider's raw answer becomes our `Metadata`** (done inside
each adapter, above) and **which source wins per field**. Our `Metadata` is the existing
ComicInfo field set from `metadata.ts`; books additionally carry `ISBN` (books add it to the editable
set; `writeEpubMetadata` gains a `dc:identifier` ISBN branch, since OPF has no series/ISBN in the
ComicInfo shape today).

Field coverage per provider is the matrix already in `docs/metadata-providers.md`; the adapter tables
above are the authoritative implementation reference. `merge.ts` holds a **per-media-class precedence
table** (constant, test-covered):

- **Comics:** `Series, Number, Volume, Writer, Penciller, Inker, Colorist, CoverArtist, Publisher,
  Imprint, Genre, Tags, LanguageISO, AgeRating` ← **Metron → GCD → ComicVine**; `Title, Summary` ←
  **ComicVine → Metron → GCD** when ComicVine is enabled, else **Metron → GCD**. `ISBN` ← Metron (rare)
  else manual.
- **Manga:** `Series, Number, Volume, Title, Summary, Writer, Genre, Tags, LanguageISO,
  AgeRating` ← **MangaDex → AniList**; light novels (library type Book/LN) ← **AniList → Hardcover →
  MangaDex**.
- **Books:** `Title, Writer, Publisher, Summary, Year, ISBN, LanguageISO` ← **Hardcover → Open Library**;
  `Series, Volume, Genre, Tags` ← **Hardcover → Open Library**; `Imprint, AgeRating` ← **PRH only**
  (when the ISBN matches a PRH title), else left manual.
- **Kavita phase 1** (`seriesMetadata`) is a *lowest-precedence* source in every class: it fills gaps a
  provider left, but a provider value always wins unless the field is locked.
- **File's own embedded metadata** is the baseline: providers enrich, they do not silently replace it.

Merge rules:

1. **Never overwrite a locked value.** Two kinds of lock: Kavita's own per-field `*Locked` flags (read
   from `GET /api/Series/metadata` for an existing series) and locks the reviewer sets in the card
   (dirty/edited fields, sent as `locked[]`). A locked field is returned untouched, with
   `skipped: "locked"` in provenance.
2. **Never overwrite a known-good value without confirmation.** A field whose current form value is
   non-empty is kept; the merge only *proposes* the provider value as a **conflict** (`conflicts[]`)
   that the reviewer must accept (a `force[]` list on `/apply`). Blank fields fill silently.
3. **Provenance per field.** `/apply` returns `fields` plus `provenance: {Field: "metron" | "gcd" |
   "kavita" | "file" | "manual"}` and `attribution[]`, so the card can show "Summary — Metron" chips
   and the required credit lines.
4. **Domain validation before the value reaches the form.** Reuse `cleanMetadata()`'s rules: `Year`
   four digits, `AgeRating` from `AGE_RATINGS` (map MangaDex `contentRating` / AniList `isAdult` onto
   the nearest allowed value, never invent one), `LanguageISO` two-letter (map MangaDex/
   Open Library codes), length caps, strip HTML from summaries (some providers return HTML), collapse
   whitespace. Anything that cannot be validated cleanly is dropped, not guessed.
5. **Conflicts and coverage are shown, not hidden.** The card lists "filled from X" and "kept yours"
   so an admin can see exactly what a provider wanted to change.

Approval is unchanged: the reviewer's final form values are what `planApproval`/`buildFinalFile` write
(as today). The merge never writes to disk itself.

---

## 2.3 Data model (SQLite) and endpoint changes

All new tables go in `src/db.ts`'s `db.exec(...)` block; column additions to existing tables follow the
`PRAGMA table_info` check convention (as `uploads`/`sessions` already do). Migrations run on start.

### `provider_config`

Admin-managed per-provider settings (replaces env-only keys for the UI path). One row per provider id.

| Column | Type | Notes |
|---|---|---|
| `provider` | TEXT PRIMARY KEY | `metron`, `gcd`, `mangadex`, `anilist`, `hardcover`, `openlibrary`, `prh`, `comicvine`, `kavitaplus` |
| `enabled` | INTEGER NOT NULL DEFAULT 0 | per-provider on/off |
| `key_sealed` | TEXT | `seal()`d token / PAT / API key (never plaintext in the DB) |
| `key_hint` | TEXT | last 4 chars, for display only |
| `username` | TEXT | Metron account label (token auth needs no user, kept for clarity) |
| `extra` | TEXT | JSON (e.g. AniList token, PRH domain — domain validated against an allowlist) |
| `updated_at` | INTEGER NOT NULL | unix ms |
| `updated_by` | TEXT | admin username |

### `metadata_cache`

Read-through cache keyed by provider + externalId, with licence metadata attached to every row.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `provider` | TEXT NOT NULL | |
| `kind` | TEXT NOT NULL | `record` \| `search` |
| `external_id` | TEXT | provider id for `record`; `''` for `search` |
| `query_hash` | TEXT | normalised query for `search`; `''` for `record` |
| `payload` | TEXT NOT NULL | JSON (`FetchedRecord` or `Candidate[]`) |
| `licence` | TEXT NOT NULL | e.g. `CC BY-SA 4.0` |
| `attribution` | TEXT NOT NULL | credit string shown in the UI |
| `source_url` | TEXT | provider page, for "view source" |
| `fetched_at` | INTEGER NOT NULL | |
| `expires_at` | INTEGER NOT NULL | per-provider TTL |

`UNIQUE(provider, kind, external_id, query_hash)`; index on `expires_at`. TTL policy: CC BY-SA / public
sources (`metron`, `gcd`, `openlibrary`, `hardcover`) records **30 days**, searches **3 days**;
`mangadex` **7 days**; `anilist` deliberately **short (≈3 days)** to respect its no-storage rule;
`comicvine` **30 days** but covers not cached at all; `prh` 30 days; `kavitaplus` mirrors Kavita's own
caches (don't duplicate). `cache.ts` purges expired rows in the existing hourly job and offers
`refresh: true` on `/apply` to bypass a hit.

### `provider_links`

Persists series → external id so a repeat upload skips search entirely and cross-IDs reconcile.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `library_id` | INTEGER | nullable for a series not yet in Kavita |
| `series_name` | TEXT NOT NULL | as seen in the review |
| `normalized_series` | TEXT NOT NULL | `normalizeSeries()` output (reused from `review.ts`) |
| `provider` | TEXT NOT NULL | |
| `external_id` | TEXT NOT NULL | |
| `external_url` | TEXT | |
| `confidence` | TEXT | `exact` \| `near` \| `manual` |
| `linked_by` | TEXT | reviewer username, or `auto` on a confirmed exact match |
| `linked_at` | INTEGER NOT NULL | |
| `UNIQUE(library_id, normalized_series, provider)` | | |

`links.ts` exposes `linkFor(libraryId, seriesName)`, `remember(link)`, and `crossIds(normalizedSeries)`
(the cross-ID set that boosts ranking). Links are written only when a reviewer confirms a candidate.

### Endpoint changes (all reviewer-only, under the existing `requireReviewer`)

- **Keep** `GET /api/review/:id/suggest` (phase 1, unchanged response) for compatibility and as the
  lowest-precedence source.
- **Add** `GET /api/review/:id/match?media=&refresh=` → `{ query, candidates[], providers[] }`.
  `candidates[]` entries: `{ provider, externalId, seriesTitle, number, volume, title, year, publisher,
  imprint, score, confidence, coverThumbUrl, sourceUrl, attribution }`. `providers[]` reports
  `{ id, name, enabled, configured, attribution, skipped: null | "disabled" | "no-key" | "cooldown",
  retryAfter }`. Uses `provider_links` to skip search when a link exists (return a prefilled candidate).
- **Add** `POST /api/review/:id/apply` body `{ provider, externalId, number?, locked?: string[],
  force?: string[], refresh?: boolean, items?: [{ id, number? }] }` → `{ fields, provenance,
  conflicts[], attribution[], coverUrl }`. Fetches (cache-aware) and merges with phase 1 + file
  defaults. Does not persist to any file; the card writes the fields into the form and the existing
  `/approve` path stores them.
- **Add** `GET /api/review/:id/provider-cover?provider=&externalId=` → proxied provider cover
  (see §2.4), reviewer-only, for the candidate list and the applied card.
- **Add** admin settings: `GET /api/admin/providers` (descriptors + enabled/configured/key hint +
  cache counts + last error + attribution), `POST /api/admin/providers/:id`
  (`{ enabled?, key?, username?, extra? }`), `POST /api/admin/providers/:id/test` (cheap search to
  verify a key), `DELETE /api/admin/providers/:id` (clear key). These reuse the review/activity
  reviewer check; the UI places them on the Activity tab (or a small "Metadata sources" panel).

No column is added to `uploads`; a fresh lookup is cheaper than persisting merged values, and the audit
log already records what was applied. Optionally add `provider_links.source_upload_id` later if we want
to trace which upload established a link — not needed for v1.

---

## 2.4 HTTP layer

`providers/http.ts` is the single outbound path for every adapter:

- **User-Agent.** A truthful, identifying default on every request:
  `kavita-companion/<version> (+<PUBLIC_ORIGIN>; mailto:<COMPANION_CONTACT_EMAIL>)`. MangaDex requires
  a real one; Open Library's 3 req/s tier wants an identified caller; the email is optional but
  recommended. The version is read from `package.json` once.
- **Timeouts.** Default 8 s via `AbortSignal.timeout`; 10 s for the two GraphQL adapters. A lookup never
  holds the request open longer than ~10 s; the route returns a degraded result instead of hanging.
- **Retries with backoff.** Up to 2 retries on network error, 5xx, or 429 only; exponential backoff
  (≈500 ms, 1 s) with jitter, capped at ~8 s; never retry other 4xx. All retries honour the caller's
  abort signal.
- **Rate limits / `Retry-After`.** A per-provider token bucket in memory, `minIntervalMs` from the
  descriptor: Metron ~3 s (20/min), GCD anon ~120 s (30/hr) or ~2 s authenticated (2000/day), MangaDex
  ~250 ms (≈5/s), AniList ~2 s (30/min, current), Hardcover ~1.1 s (60/min), Open Library ~1.1 s.
  On 429 (or Metron's `X-RateLimit-Burst-*`/`Sustained-*`, AniList's `X-RateLimit-*`) parse
  `Retry-After` (seconds or HTTP-date) and set a **cooldown** until then; `/match` then reports the
  provider as `skipped: "cooldown"` with `retryAfter` rather than failing. Cooldowns are in memory and
  logged once.
- **Response handling.** `Content-Type`/`Accept` for JSON, max response size (≈2 MB) enforced, HTML
  bodies rejected, JSON parsed defensively; provider errors (`{errors:[…]}` in a 200 GraphQL body) become
  typed errors handled by `graphql.ts`.
- **GraphQL vs REST.** `metron`, `gcd`, `mangadex`, `openlibrary`, `prh`, `comicvine`, and `kavitaplus`
  are REST. `anilist` and `hardcover` are GraphQL POSTs through `graphql.ts`; Hardcover's "each
  top-level field = 1 request" rule is handled by folding related fields into **one** query per fetch
  to stay inside 60/min, watching the 30 s query timeout (the 2 s search path is separate).
- **Image proxying.** `providers/http.ts` also backs the cover route: fetch the provider image
  server-side (MangaDex has no third-party CORS and forbids hotlinking), cap size (≈8 MB), pass through
  the upstream `Content-Type` (allow only image types), and send `Cache-Control: private, max-age=…`.
  The browser's existing CSP (`img-src 'self' blob: data:`) already forbids external images, so the
  proxy is required, not optional. **Cover policy differs per provider:** MangaDex covers are proxied
  (and may be cached briefly in memory); Metron and ComicVine covers are explicitly excluded from
  rehosting — for those the proxy only streams on demand with no disk cache, and if a provider forbids
  it entirely the candidate row shows a letter placeholder instead.
- **Fixed hosts, no user input.** Every adapter's base URL and paths are constants. Admin-supplied
  `extra` (PRH domain) is validated against a small allowlist; nothing else in a provider request comes
  from a user or from provider response data (no request built by following a returned URL).

### Enable flags and key storage

- A provider is used only when `provider_config.enabled = 1` **and** `isConfigured()` is true. Keys are
  stored **encrypted with `seal.ts`** (AES-256-GCM, `COMPANION_SECRET`), exactly like session tokens,
  so they are changeable from the admin UI without a rebuild and are never readable from the DB
  (`key_hint` holds only the last 4 characters). `.env` remains supported as a provisioning seed for
  compose-managed installs; when both are set, the `.env` value wins (documented), so an operator can
  pin a key outside the UI.
- `comicvine` additionally requires `PROVIDER_LEGAL_ACK_COMICVINE=true` before it can be enabled, so its
  non-commercial / "do not reproduce" terms are an explicit, conscious choice.

### Environment additions (`config.ts`, `.env.example`, `compose.yaml`)

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDERS_DEFAULT_ENABLED` | `metron,gcd,mangadex,anilist,hardcover,openlibrary` | providers enabled when no `provider_config` row exists |
| `PROVIDER_METRON_TOKEN` / `PROVIDER_METRON_USERNAME` | empty | Metron bearer token (per-install free account) |
| `PROVIDER_HARDCOVER_TOKEN` | empty | Hardcover PAT |
| `PROVIDER_ANILIST_TOKEN` | empty | optional (AniList reads need none) |
| `PROVIDER_PRH_KEY` / `PROVIDER_PRH_DOMAIN` | empty | PRH enrichment; domain allowlisted |
| `PROVIDER_COMICVINE_KEY` | empty | ComicVine (opt-in) |
| `PROVIDER_LEGAL_ACK_COMICVINE` | `false` | required before ComicVine can be enabled |
| `PROVIDER_HTTP_TIMEOUT_MS` | `8000` | outbound timeout |
| `PROVIDER_CACHE_TTL_DAYS` | per-provider | overrides default record TTL |
| `PROVIDER_CACHE_MAX_MB` | `64` | cap on `metadata_cache` payload bytes; oldest purged first |
| `COMPANION_CONTACT_EMAIL` | empty | appended to the User-Agent for provider politeness |
| `KAVITA_PLUS_PREFER` | `true` | prefer Kavita+ delegation when a licence is present |

`setup.sh` gets an optional prompt for the Metron token (the one provider that is useless without a
key); everything else is set later in the admin panel. The logger serializer in `server.ts` is extended
to redact `token`/`key`/`apiKey` query parameters and request headers, matching the existing
`apiKey=[redacted]` rule.

---

## 2.5 Integration points with existing features

- **Review card (`web/main.js` `groupCard`, `itemRow`).** Phase 1's single `/suggest` call becomes a
  **"Find metadata"** control that calls `/match` and renders provider chips with attribution. Choosing a
  candidate calls `/apply`; the returned `fields` fill the existing shared inputs and per-row
  Number/Volume/Title/Summary exactly as the current "use Kavita's …" button does, with a small
  provenance chip per field ("from Metron") and conflict prompts ("Metron says Publisher X; keep
  yours?"). The phase-1 Kavita suggestion stays visible as its own source and is included in `/match`
  output as the lowest-precedence candidate, so the UI is one list, not two features. No new tab; §7's
  Review tab already hosts the card.
- **Requests (§2, `requests.ts`).** `fulfilRequests` matches on `normalize(normalised series) +
  number`; provider links improve that by letting a request (e.g. "Halcyon (2012)") match the canonical
  linked series name. Optionally store `provider`/`external_id` on a request so the admin's fulfil flow
  can pull the same cover/metadata. Scope: start with link-assisted matching only; no schema change to
  `requests` is required (the link lookup is by normalised name + library).
- **Notifications (§1, `notify.ts`).** No new user-facing events by default. Add one **opt-in admin
  event** `provider_error` (key rejected/expired, or a long cooldown) routed through the existing
  `notifications` outbox, so an admin learns a source is down before reviewers get stuck; and reuse the
  outbox pattern rather than calling providers from the request path. Metadata application itself is
  not a notification — it is an audit fact.
- **Activity log (`activity.ts` + `audit()`).** New audit actions: `provider_fetch` (provider,
  externalId, cached?) at a low volume, `metadata_applied` (upload id, provider, changed fields,
  conflicts), `provider_key_set` / `provider_key_cleared`, `provider_error`. They appear in the existing
  Activity panel filters unchanged; labels are added to the panel's action list. Activity stays
  reviewer-only.
- **Kavita+ delegation (R4) as a preferred path — OUT OF SCOPE (decision 1); kept for history.** A `kavitaplus` adapter implements the same interface
  against Kavita's own REST API: detect with `GET /api/License/has-license` (and `/valid-license`),
  match with `POST /api/Series/match`, read richer fields from `GET /api/Metadata/series-detail-plus`
  and external IDs from `GET /api/Series/{id}`. When a licence is present and `KAVITA_PLUS_PREFER` is
  true, it is listed first and pre-selected in `/match`, with direct providers as fallback. **Caveat
  that shapes the design:** Kavita+ needs the series to exist in Kavita first, so it fits the *fix* /
  existing-series flow best and cannot help a brand-new series until after approval; direct providers
  are therefore the primary path for first-time uploads. `POST /api/Series/refresh-metadata` and
  `/api/Library/refresh-metadata` are **not** used (they regenerate covers, per `docs/research/R4`).

---

## 2.6 Recommended build order and the risky/bespoke bits

Thin vertical slice first — one provider, one media class, all the way to an approved file, before
adding breadth:

0. **Scaffolding.** `types.ts`, `registry.ts`, `http.ts`, `match.ts`, `merge.ts`, `cache.ts`,
   `links.ts`; the three tables in `db.ts`; `GET /api/review/:id/match` and `POST …/apply` returning
   `{candidates: [], providers: [...]}` with no adapters yet; review-card candidate list UI. Proves the
   plumbing with zero network calls.
1. **Open Library (books, no key, no proxy).** Simplest end-to-end: `/match` → candidate → `/apply` →
   merged OPF fields → approve writes them. Establishes merge/provenance/conflict behaviour and the
   OPF `ISBN` writer.
2. **GCD (comics, no key).** Real comic field mapping incl. free-text credit parsing and free-text
   volume; exercises `provider_links` and cross-ID reconciliation.
3. **MangaDex (manga) + cover proxy + `Retry-After`.** Adds the UA, image proxy, and cooldown handling
   that the research flags as mandatory.
4. **Metron (keyed) + admin key panel + skip-search via links.** The flagship comics source; proves
   `provider_config`, sealed keys, and `/api/admin/providers`.
5. **Hardcover (GraphQL) + PRH (opt-in ISBN enrichment).** Adds `graphql.ts`, the field-folding rule,
   and the only real Imprint/AgeRating source.
6. **AniList (light novels + manga secondary).** Short TTL and the strict-ToS guardrails.
7. **Kavita+ delegation adapter + `KAVITA_PLUS_PREFER` — OUT OF SCOPE (decision 1); not built.** Was:
   wire R4 as the preferred path when licensed.
8. **ComicVine opt-in** behind `PROVIDER_LEGAL_ACK_COMICVINE`; covers excluded from rehosting.

Test tiering follows §6/tests: a fast, offline tier stubs `fetch` and asserts ranking + merge +
precedence + lock/conflict rules without network, and a small opt-in tier runs a real lookup per
provider (skipped when no key).

**Risky / bespoke bits.**

- **False matches.** Sequels/spin-offs, "(2012)" suffixes, roman numerals, volume-vs-issue confusion,
  and translated/alternate titles. Ranking plus mandatory human confirmation mitigate this; the merge
  never auto-applies.
- **Free-text data.** GCD credits and volumes are `;`/`?`-separated free text and often blank; parse
  conservatively and drop uncertain fragments rather than guessing a role.
- **Licence obligations.** Metron/GCD CC BY-SA attribution (and ShareAlike on what we *distribute*);
  MangaDex credit + no ads; AniList no-storage/no-hoarding (hence a short TTL and no bulk); ComicVine's
  non-commercial "no reproduce" tension; PRH no bulk redistribution. Attribution strings live on the
  descriptor, are stored in `metadata_cache`, and must be shown on the review card and About page.
- **Per-install credentials.** Metron policy expects each install/user to have their own token; the
  admin-supplied per-install token is the closest fit, but this is a policy nuance to document, not a
  code guarantee.
- **Rate limits and bans.** MangaDex can temporarily 403 a bursting IP; Metron/GCD/AniList have hard
  ceilings. The token bucket + cooldown + "never bulk" rule is the guard; the admin panel shows the
  cooldown so a reviewer understands an empty result.
- **Covers.** Metron/ComicVine forbid rehosting; MangaDex forbids hotlinking. The proxy's per-provider
  cache policy (memory-only / on-demand) encodes this.
- **Kavita+ constraints.** Node-locked licence, latest-3-versions window, 50 match/refresh per 24 h for
  background work, and the "series must exist" requirement — so delegation is a preference, never the
  only path.
- **Merging is the product.** Precedence, locks, known-good protection, and provenance are where a
  wrong implementation writes bad metadata into users' files; they are the parts that need the most
  tests.

---

# 03 — Search & Browse

**Goal (owner's words):** after phase 2, the outcome should be *"a very clean, searchable, browseable
library of the items served by Kavita."* Metadata is written into files at approval and Kavita indexes
them, so the companion's job is to (a) help admins see and close metadata gaps, and (b) give a thin
discovery/QA surface over Kavita's catalogue — **not** a second reader.

Scope note: phase 1 (shipped, 0.2.7) already reads the matching Kavita series' metadata into the review
card (`GET /api/review/:id/suggest` → `suggestFor()` in `src/review.ts`, which calls
`GET /api/Series/metadata`). Phase 2 adds external providers ([metadata-providers.md](../../docs/metadata-providers.md)).
This section covers how the result is *measured* and *surfaced*, not how providers are chosen.

Relevant Kavita facts ([kavita-api.md](../../docs/kavita-api.md)):
`POST /api/Search/search?queryString=&includeChapterAndFiles=` → series/persons/genres/tags/chapters/files;
`POST /api/Series/v2` (and `/api/Series/all-v2`) body `SeriesFilterV2Dto` → structured browse;
`GET /api/Series/{id}`, `GET /api/Series/metadata?seriesId=`, `GET /api/Series/volumes?seriesId=` (volumes
carry full `ChapterDto` metadata per issue); `POST /api/Series/metadata` (`UpdateSeriesMetadataDto`) and
`POST /api/Series/update` (`UpdateSeriesDto`, incl. external IDs) write back; `/api/Metadata/*` supplies
filter facets. Kavita+ adds `GET /api/License/{has-license,valid-license,info,provider-health}`,
`GET /api/Metadata/series-detail-plus`, `POST /api/Series/{match,update-match}` (capped at 50 matches/24 h).

---

## 1. What "clean" means, and how to measure it

### 1.1 Definition

Decision 10 in [decisions.md](../../docs/decisions.md) is the anchor: **embedded metadata is the source of
truth** because Kavita trusts `ComicInfo.xml` / the EPUB OPF over folder and file names. So:

- A series/issue is **clean** when it carries the key fields (below) *and* Kavita's own record agrees.
  Correctness of a value (e.g. "is this really the writer?") is judged by a human; the score measures
  **presence of the fields that make items findable and groupable**.
- "Clean" is a spectrum, not a boolean. Report it as both a count (`n / m key fields`) and a 0–100 score.

### 1.2 Key fields, in tiers

| Tier | Series-level (from `SeriesMetadataDto`) | Issue-level (from `ChapterDto`) |
|---|---|---|
| **Identity** (must have) | name, `releaseYear` | number/chapter, `files` non-empty, title or number present |
| **Discovery** (should have) | `summary`, `genres`, `tags`, `publishers`, `writers` | `summary`, `genres`, `tags`, `writers` |
| **Polish** (nice) | `imprints`, `ageRating`, `language`, `publicationStatus`, `coverArtists` | `ageRating`, `language`, `isbn` (books), `releaseDate` |
| **Derived** | cover image present, external id set (aniList/mal/hardcover/metron/comicVine/mangaBaka) | pages > 0 |

Weight identity ×3, discovery ×2, polish ×1, derived ×1 (tunable; documented in one place). A series with
no `summary` **and** no `genres`/`tags` is the classic "invisible in search" case and should score low even
if it has a name.

### 1.3 Where the data comes from (no file reads needed)

- **Series:** `GET /api/Series/metadata?seriesId=` per series.
- **Issues:** `GET /api/Series/volumes?seriesId=` — its `chapters[]` are full `ChapterDto` objects carrying
  `summary`, `genres`, `tags`, `writers`, `publishers`, `imprints`, `language`, `ageRating`, `isbn`,
  `releaseDate`. The existing `seriesContents()` parser in `src/kavita.ts` already walks this tree; extend it
  (or add a sibling) to also return completeness, so **no file is opened and no library scan is triggered**.
- **Portal uploads:** the `uploads` table already stores the final metadata plan (`approval_plan`) and the
  pre-approval `inspection`; use these to cross-check that what the portal wrote matches what Kavita shows,
  and to seed issues not yet confirmed (`kavita_status != 'confirmed'`).
- **Not built:** reading every `ComicInfo.xml` off disk. Too slow for a whole library and unnecessary given
  `ChapterDto`. Keep the existing per-file `inspect.ts` path for the review/fix editor only.

### 1.4 Surfacing it to admins

- **Library tab header** (new, §4): per-library summary cards — `clean / total series`, worst offenders,
  last computed. Mirrors the `.insights` cards already used by Activity.
- **Series detail:** a small completeness meter plus a per-tier chip list ("missing: summary, genres,
  imprint"). Per-issue rows show a compact gap badge.
- **Activity insights** (existing `GET /api/admin/insights`): add one card — "series below threshold" —
  so the ops view answers *"is the library getting cleaner?"* over time.
- **Measure of success:** median series completeness, count of series below threshold, and the trend after
  applying fills.

### 1.5 "Needs metadata" queue

A ranked list, newest/lowest score first, of **everything**, not just portal uploads:

1. Series whose score is below a threshold (default: identity complete but discovery empty).
2. Issues inside otherwise-clean series that are missing identity/discovery fields (`ChapterDto` empty).
3. Portal uploads with `review_error`, or `kavita_status = 'missing'` (written but not indexed — a data
   problem, not a metadata one, but it belongs here).
4. Series with no external id set (a hint that no provider has ever matched them).

Ranking key: lowest tier first (identity > discovery > polish), then oldest `lastChapterAdded`, then name.
Filters: library, tier, "only files the portal wrote". Paged.

### 1.6 Bulk-provider-fill for an existing series

Admin-triggered, and **per series** by default — never a whole-library sweep.

- Entry: series detail → "Fill from provider…". Runs the phase-2 resolver (§4.4) against the series' likely
  ids, shows a **dry-run diff** (current → proposed, field by field) and requires **Confirm**.
- Rate limiting: a per-provider token bucket on the server (one shared limiter, concurrency 1, like the
  approval queue in `src/review.ts`), honour `Retry-After`, one lookup per action, **no polling**. A series
  batch is sequential with visible progress, not fire-and-forget.
- **Never bulk-hoard:** do not mirror provider data into a companion table. Persist only the provider id
  (via `POST /api/Series/update` external ids) so re-search is skipped, and keep fetched payloads in a
  short-lived in-memory/on-disk cache only (per the licensing table in metadata-providers.md — AniList's
  no-storage clause, Google Books' no-permanent-copy clause).
- Writes go through the **file path** (§3) so they survive a rescan.

---

## 2. Companion-side search & browse: build vs leave to Kavita

### 2.1 Principle

Kavita is the **reader and the catalogue of record**. The companion is a **thin discovery + QA** view whose
one unique job is showing metadata gaps; everything else is a jump-off. Anything that is not about finding
an item or fixing its metadata should not be rebuilt.

### 2.2 What we build on top of Kavita's API

| Need | Endpoint | Notes |
|---|---|---|
| Free-text search | `POST /api/Search/search?queryString=&includeChapterAndFiles=false` | Returns series, persons, genres, tags, chapters, files as one `SearchResultGroupDto`; group facets client-side. |
| Structured browse | `POST /api/Series/v2?PageNumber=&PageSize=` | `SeriesFilterV2Dto.statements[{comparison, field, value}]`, `combination` 0=Or/1=And. |
| Sort | same body `sortOptions { sortField, isAscending }` | `SeriesSortField`: 1 sort name, 2 created, 3 last modified, 4 last chapter added, 6 release year, 8 average rating. |
| Filter by library / genre / tag / person / year / status | same body | `SeriesFilterField`: 19 libraries, 18 genres, 6 tags, 17 writers, 16 pencillers, 12 cover artist, 22 release year, 2 publication status, 4 age rating, 29 imprint, 10 publisher. |
| Filter facets & counts | `/api/Metadata/{genres,tags}-with-counts`, `/api/Metadata/people-by-role`, `/api/Metadata/age-ratings`, `/api/Metadata/publication-status`, `/api/Metadata/all-languages` | Cache like `librariesCached()`. |
| Series detail | `GET /api/Series/{id}` + `GET /api/Series/metadata` + `GET /api/Series/volumes` | Ids on `SeriesDto` also drive the provider resolver. |

### 2.3 Tradeoffs to state explicitly

- **Do not duplicate the reader.** No in-companion paging, no reading progress, no bookmarks, no
  collections/reading lists, no ratings. Series detail ends with **Open in Kavita**
  (`/library/<libraryId>/series/<seriesId>`, the link `kavitaSeriesUrl()` already builds).
- **The view duplicates part of Kavita's own browse UI.** Its only justification is the QA lens (gaps,
  completeness, "needs metadata"), so keep it thin: search → results → series detail with gaps → act or jump.
- **Visibility.** `Series/v2` and `Search/search` run with the portal's admin key and return the whole
  library regardless of the requesting user's library permissions. The Library tab is therefore
  **reviewer-only in v1** (same gate as Review/Activity). Exposing it to non-admins would require filtering
  results by the user's Kavita libraries — a later, deliberate change.
- **Paging & cost.** `Series/v2` is already paged 500 at a time; the UI should request a page at a time and
  cache facet lists, or a large library means a slow first paint.

---

## 3. The admin QA workflow

One loop, reachable from the Library tab, the "needs metadata" queue, and the existing Review tab:

1. **Find** — search/filter, or open the queue; sort by lowest completeness.
2. **Inspect** — series detail: current metadata, per-issue gaps, Kavita's external ids, whether Kavita+
   is licensed.
3. **Fetch** — "Suggest": run the phase-2 resolver (Kavita+ first if licensed, else the library-type
   default provider). Show provenance and attribution ("from Metron, CC BY-SA 4.0"). One request per action.
4. **Confirm** — a diff of current → proposed, per-field accept/reject, always human-confirmed.
5. **Apply** — two paths, and the UI must say which one it chose and why:
   - **Path A — fix the file (durable, preferred).** Reuses the existing fix job
     (`POST /api/review/:id/fix` → `runJob` in `src/review.ts`) for files the portal uploaded: repack CBZ /
     rewrite the OPF, move if the name changed, rescan. Survives every future scan or Kavita+ refresh.
   - **Path B — update Kavita's metadata (fast, volatile).** `POST /api/Series/metadata`
     (`UpdateSeriesMetadataDto`) or the chapter equivalent. **Warn that it does not survive a rescan or a
     metadata refresh**, because embedded data wins (decision 10). Reserve it for fields the file can't
     carry well (e.g. `publicationStatus`) or when the file is missing.
   - *Open decision:* Path A needs an `uploads` row, but the library also holds series the portal never
     touched. Options: (a) v1 restricts durable fixes to portal-uploaded files and uses Path B for the rest;
     (b) add a `library_fix` job keyed on series folder + file that reuses `planApproval`'s file-building
     without a staging row. Recommend (a) for v1, (b) if the "Fix…" experience must cover the whole library.
6. **Kavita+ variant** — if licensed, `POST /api/Series/match` / `update-match`, then read
   `series-detail-plus`; show remaining budget (the 50/24 h cap is easy to exhaust) and prefer it over direct
   providers when present.
7. **Log** — new audit actions so the existing Activity tab tells the story: `metadata_suggest`,
   `metadata_fill`, `metadata_update`, `library_fix`, `metadata_bulk_fill`. Every apply carries who, which
   series/files, fields changed, and source. Reuse `audit()`; no new table required.

Guardrails: reviewer-only; provider text untrusted (strip HTML, cap length); keys stored encrypted like
sessions or in `.env`; single concurrency; failures never block a fix.

---

## 4. Concrete UI, endpoints, composition

### 4.1 New tab

Add one tab, **Library**, to the existing tab bar (`public/index.html` + the `TABS` array in
`web/main.js`): `{ id: "library", tab: "tab-library", panels: ["library-section"], canSee: user => user.isReviewer,
onShow: () => refreshLibrary() }`. It lives in `location.hash` (`#library`) and gets arrow-key navigation
for free. Keep the tab bar to one new entry by giving the tab **two sub-views** toggled in place rather than
two tabs:

- **Browse** — search box, filter bar, results grid.
- **Needs metadata** — the ranked queue (default sub-view when the library has gaps).

Also surface entry points from the Review tab: after a fix, and on the "Find an approved file to fix" panel,
link into the matching Library series detail.

### 4.2 Layout & design tokens

Reuse the existing look (`public/style.css`): `.cover-tile`, `.badge`, `.btn`/`.btn-outline`,
`.field`, `.insights`/`.insight`, `.grid-2`/`.grid-3`, `--surface`, `--surface-solid`, `--border`,
`--primary`, `--muted`, `--radius`, `--warning-text`. Add only `.library-*` helpers:

- A **completeness meter**: a thin bar (`--primary` fill on a `--border` track) plus `n / m` text; a chip row
  for missing tiers (`--warning-text`).
- A **series card** = Kavita series tile (cover, caption) with a small score chip and gap count.
- Results grid uses `repeat(auto-fill, minmax(9rem, 1fr))`, like the insight grid, so it reflows on phones.

### 4.3 Companion endpoints (all reviewer-only, prefix `/api/library`)

| Endpoint | Does |
|---|---|
| `GET /api/library/facets` | Cached libraries + genres/tags/people/status/ages with counts. |
| `GET /api/library/series?query=&libraryId=&genre=&tag=&person=&year=&status=&sort=&page=` | Search (`Search/search`) or filter (`Series/v2`); returns tiles + score chip. |
| `GET /api/library/series/:id` | Kavita `SeriesDto` + metadata + volumes/chapters, each with completeness and gap lists. |
| `GET /api/library/needs-metadata?library=&tier=&page=` | The ranked queue. |
| `GET /api/library/series/:id/cover` | Proxies Kavita's cover (or just links to it), so the tile looks right. |
| `POST /api/library/series/:id/suggest` | Provider lookup; returns fields + source + attribution; does not write. |
| `POST /api/library/series/:id/apply` | Body `{ fields, target: "file" \| "kavita" }`; enqueues a fix job or writes Kavita metadata; audits. |
| `POST /api/library/series/:id/bulk-fill` | Admin-triggered, dry-run then confirm, rate-limited; audits. |
| `GET /api/library/kavita-plus` | Licence status/budget for the UI (optional). |

### 4.4 Composition with phase 1 / phase 2

The phase-1 `suggestFor()` logic (find the same-named series, read `Series/metadata`, map to fields) should be
**extracted into a shared resolver module** used by:
`GET /api/review/:id/suggest` (unchanged endpoint), the new `series/:id/suggest`, the bulk-fill job, and the
phase-2 external providers. This keeps one implementation of "what fields can we fill and from where", with
provenance and attribution returned alongside, and means the review card's future external-provider button
and the Library tab behave identically. The apply step reuses `planApproval`/`runJob` for file writes, so a
Library-tab fix and a Review-tab fix are literally the same job.

---

## 5. Prioritisation

### Essential for "clean / searchable / browseable"

1. **Completeness scoring** (series from `SeriesMetadataDto`, issues from `ChapterDto`) — read-only, cheap,
   immediately useful, and the measure of success.
2. **"Needs metadata" queue** over the whole library (not just portal uploads).
3. **Library tab: search + structured filter + series detail with gaps + Open in Kavita.**
4. **Reuse phase-1 suggest to fill gaps**, applied through the **existing Fix flow** for portal-uploaded
   files, plus **Path B** (`POST /api/Series/metadata`) with the rescan warning for the rest.
5. **Activity logging** of every suggest/apply, so the loop is visible and auditable.

### Nice-to-have

- Bulk-provider-fill (build the plumbing; keep it per-series and explicitly confirmed).
- Kavita+ match/refresh integration and budget display.
- Saved views, sort-by-completeness, deeper facet counts, "portal wrote this" filter.
- External-id persistence via `POST /api/Series/update` to skip re-search.

### Explicitly out of scope

- A reader, reading progress, collections, ratings, want-to-read (Kavita owns these).
- Exposing the Library tab to non-admins before per-user library filtering exists.
- Mirroring provider data into companion tables (licensing/ToS) or whole-library auto-fill.

### Suggested order within phase 2

(a) scoring + needs queue → (b) Library browse/detail → (c) shared suggest resolver → (d) apply-to-Kavita and
file-fix wiring → (e) bulk-fill → (f) Kavita+ integration. The first two alone already deliver "searchable,
browseable, and measurable"; (c)–(f) deliver "clean".

---

# 04 — QA / Test plan: direct metadata-provider integration

Scope: the companion's direct integrations with **Metron, GCD, MangaDex, AniList, Hardcover, Open
Library** (optional **PRH**; **ComicVine** opt-in) that fetch data and write it into files. This section
covers how to prove the adapters, the match/rank/apply flow, caching and key handling, compliance with
each provider's terms, and how all of that stays inside the existing **light, fast, tight** test style.

## Guiding principles (owner's preference)

- **No network, no real keys, no live providers — ever, in any tier.** Every provider base URL is a
  configuration value (`config.ts`), so the test stack points them at a local fake. CI and the test stack
  simply cannot reach metron.cloud / mangadex.org / hardcover.app; a test that needs the internet is a
  bug in the test.
- **Fast tier stays the default.** New behaviour is verified against a fake provider from the portal over
  its real HTTP endpoints, uploading files but **not approving them** — the same shape as
  `test_notifications.py`, which already uploads, discards and rejects without touching the library.
- **Deterministic.** Fixtures are fixed; the only random token is for cleanup names. Assertions use
  `check()`/`finish()` and `wait_until()`, never bare `sleep` longer than ~1s except a controlled
  cache-TTL window.
- **Reuse the harness.** `harness.app/kavita/login/upload/wait_pending/check/finish`, plus one new shared
  helper module for the fake provider (the same role the `Receiver` class plays for notifications).

---

## 1. Provider adapters without the network or keys

### 1.1 The fake provider (shared helper, not a test)

New file **`tests/provider_fake.py`** — a small, stdlib-only, threaded `http.server.HTTPServer` bound to
`0.0.0.0` on a free port, started by the test process, exactly like the webhook receiver in
`test_notifications.py`. The portal container reaches it through the Docker gateway
(`DOCKER_GATEWAY`, default `172.31.0.1` in the test stack), so `PROVIDER_FAKE_URL =
http://<DOCKER_GATEWAY>:<port>`.

It exposes one path tree per provider (`/metron/…`, `/gcd/…`, `/mangadex/…`, `/anilist/graphql`,
`/hardcover/…`, `/openlibrary/…`, `/prh/…`, `/comicvine/…`) and:

- **Routes request → fixture.** A tiny router maps method + path + query (e.g.
  `GET /metron/series/?name=Fixture+Saga`) to a recorded JSON body from `tests/fixtures/providers/`.
  Each provider gets a *search/candidate* fixture (a list) and an *issue/volume detail* fixture.
- **Records every request** (method, path, query, headers, body) in an in-memory log, so tests can
  assert **call counts**, the **`User-Agent`**, and any auth header. Accessor helpers: `requests()`,
  `count(provider)`, `last_headers(provider)`.
- **Scriptable behaviours.** A per-request "program" list lets a test queue the next response as
  `429 + Retry-After`, `500`, a **hang** (never responds, to exercise the client timeout), **malformed
  JSON**, **oversized body** (to hit the size cap) or **HTML-in-summary** (to check strippping).
- **Teardown** in a `finally`/`server.shutdown()` so a failing assertion never leaves the port bound.
- A standalone entry point (see §4) so the browser tier can run the *same* fake on the host.

### 1.2 Recorded fixtures (`tests/fixtures/providers/`)

One directory per provider, small hand-written JSON payloads that contain exactly the fields each adapter
reads — **not** rehosted provider content (keeps us clear of Metron's fair-use cover images and of
reproducing licensed blurbs). Per provider: a **golden** detail record, one or two **alternate**
candidates for ranking, and one **edge** record (missing optional fields). A short `README` in the
directory states provenance ("synthetic, field-shaped, no real world data") and the fixture's licence
status. Fixtures are data, so edits are reviewable diffs.

### 1.3 Test stack configuration (test-only, in `.env.test.example`)

- Each provider's base URL → the fake (`METRON_BASE_URL`, `MANGADEX_BASE_URL`, `ANILIST_BASE_URL`,
  `HARDCOVER_BASE_URL`, `OPENLIBRARY_BASE_URL`, `COMICVINE_BASE_URL`, …).
- An allow-private/provider-host switch mirroring `NOTIFY_ALLOW_PRIVATE`, so the portal is permitted to
  call the gateway address in the test stack only.
- A short **cache TTL** knob (e.g. `PROVIDER_CACHE_TTL_MS=1000`) so TTL expiry is testable without
  long sleeps.
- Dummy tokens are supplied at runtime through the admin settings path (§3), never committed.

### 1.4 Contract tests — `tests/test_providers_contract.py` *(fast)*

For each adapter, in one pass over one deterministic upload (a ComicInfo/EPUB with a fixture-known
Series/Number), drive the real suggest endpoint and assert **search → rank → map**:

- **Search.** The fake sees the expected query for the fixture title; a provider with no key/disabled is
  never called.
- **Rank.** With the *alternate* fixture served alongside the golden one, the adapter returns the golden
  candidate first (volume/number/year/series disambiguation is deterministic).
- **Map (golden fields).** Field-by-field equality against a table per provider, driven from
  `metadata-providers.md`'s coverage matrix: e.g. Metron `Imprint`/`LanguageISO`, Hardcover
  `Series`/`Volume`/`ISBN`, Open Library fallback fields, MangaDex attribution. One `check()` per field
  so a failure names the broken mapping.
- **Provenance.** Each returned field carries its source provider + licence, not just a value.

### 1.5 Resilience tests — `tests/test_providers_resilience.py` *(fast)*

- **429 / rate-limit.** Fixture returns `429` with `Retry-After: 2`; assert the portal surfaces "busy,
  try again" and **does not retry before 2s**, and that a second immediate request does **not** add an
  upstream call.
- **5xx / retry.** `500` then success: assert bounded retries (a small, configured maximum) and a
  successful result; `500` always: graceful degradation, no crash, review still usable.
- **Timeout / hang.** The fake never answers: the client's timeout fires, the suggest call returns
  within budget with a clear message.
- **Malformed / oversized / HTML.** Invalid JSON → treated as an outage; body over the cap → truncated/
  refused; `<script>`/`<b>` in a summary → **stripped to plain text** before it reaches the UI/fields.
- **Fallback.** Provider outage must not break review: the card still shows Kavita-only (phase 1)
  suggestions with a warning (asserts the phase-1 path is untouched).

All of the above live in the **fast tier**: uploads are inspected but never approved, so nothing is
written to the library.

---

## 2. Match / rank / apply flow

### 2.1 Flow tests — `tests/test_metadata_suggest.py` *(fast)*

Deterministic fixtures drive precedence and merging:

- **Provider precedence.** Comics: **Metron > GCD > (ComicVine only if enabled)**; manga:
  **MangaDex > AniList**; books: **Hardcover > Open Library**; PRH enriches Imprint/AgeRating only when
  enabled. Serve each provider a fixture that fills *different* fields and assert the merged result uses
  the higher-precedence value per field, with lower-precedence providers filling only the gaps.
- **Merge.** A field absent from the primary is taken from the fallback; a field present in the primary
  is never overwritten by the fallback.
- **Don't overwrite locked values.** Upload with embedded `Series`/`Writer` (and, in a second case, a
  field the admin has edited/locked before applying). Applying a suggestion must keep the file's/
  admin's values and fill only the empty ones. Assert the exact bytes in the written metadata are
  unchanged for locked fields.
- **Unknown title.** No match → blank fields, no error, the card still works.
- **Kavita-only precedence.** When an existing Kavita series matches, its values win as today
  (`test_metadata_match.py` behaviour is preserved); external providers only fill what Kavita lacks.

### 2.2 Browser check — `tests/browser/suggestion_card.py` *(browser)*

Signed in as `test-admin`, with the fake provider reachable from the portal:

1. Upload a deterministic `.cbz`; open its review card once ready.
2. Assert the card shows a **"Suggested from <Provider>"** chip, the per-field values, and the
   **attribution + licence link** (§6).
3. Click **"Use these"**; assert the editor fields fill and the generated file name follows.
4. Lock/keep an embedded field; apply; assert it is **not** overwritten.
5. Take the fake down; refresh; assert the card degrades to Kavita-only with a clear message and no
   console errors. Screenshot as usual (`tests/screenshots/`).

Ownership in `tests/run.sh`: the browser tier can't start an in-process fake (it runs inside the
Playwright container), so `run.sh` starts **`tests/provider_fake_server.py`** on the host (the standalone
sibling of `provider_fake.py`) before `browser/suggestion_card.py`, waits for its health, and stops it
afterwards — see §4. The portal is already pointed at that host address by `.env.test`.

---

## 3. Cache / TTL and key storage (no real keys)

### `tests/test_providers_cache_keys.py` *(fast)*

**Cache / TTL** (short TTL configured for the test stack, polled with `wait_until`):

- Identical second suggest **within TTL** → fixture request count stays **1**; responses are byte-identical.
- After the TTL elapses → exactly **1** new upstream request.
- The cache key includes provider + normalised query: a hit for Metron never serves a GCD request.
- **Negative results** are not cached indefinitely: a `500` then a retry reaches the fake again.
- **Persisted provider IDs skip re-search**: once an upload/series is matched, a re-suggest uses the
  stored provider id with **zero** search requests.

**Key storage, using dummy values only:**

- Setting a fake key (e.g. `test-key-<random>`) through the admin config path succeeds; the key is sent
  to the fake in the expected header (fake records it).
- **Redaction:** the config GET never echoes the key (last-4/`••••` only); suggest responses and the
  audit log never contain it.
- **At rest:** read `settings.COMPANION_DB` and assert the plaintext key does **not** appear (stored
  encrypted, like sessions); assert it also doesn't appear in `docker compose logs` output captured via
  the harness helper.
- **Defaults:** no provider is enabled with a baked-in key; **ComicVine is off** until explicitly opted
  in, and is skipped (not called) when enabled without a key. `.env.example` ships empty placeholders.
- With a provider keyless (MangaDex/AniList/Open Library), the correct `User-Agent` stands in for the
  key (§6).

Everything here uses the fake and dummy strings; **no real credential is ever required or introduced**.

---

## 4. Keeping the existing acceptance tests fast

Tier split, staying true to `run.sh`:

| Tier | Belongs here | Excluded |
|---|---|---|
| **fast** (default, `--fast`) | all provider contract/resilience/cache/key/flow tests (upload + inspect + suggest, **no approval**) | anything that writes to the library |
| **slow** (`--slow`) | only an **end-to-end "apply writes the file"** case: one approval that lands the merged metadata in a CBZ/EPUB and lets Kavita list it | provider HTTP detail (already proven fast) |
| **browser** (`--browser`) | `browser/suggestion_card.py` only | provider internals |
| **roles** | unchanged | — |

How the guarantee is kept:

- **Never call a live provider.** Base URLs in `.env.test` point at the fake; the portal is only allowed
  to reach the gateway/private host in the test stack; a fast assertion confirms that with the fake
  *down* a suggest degrades gracefully (proving there is no silent fallback to the real internet).
- **One shared fake per test process**, started once and torn down in `finally`; provider tests reuse a
  single upload where possible to avoid repeated inspection.
- **Harness usage** matches the existing style: `from harness import app, check, finish, login, upload,
  wait_pending, wait_until, run`; `provider_fake.py` is imported like `browser_helpers.py` is by browser
  tests. No test file re-implements `app`/`login`/`upload`.
- `run.sh` gains: the new fast files appended to `fast_tests`; `suggestion_card` appended to
  `browser_tests`; a `start_fake`/`stop_fake` pair (a small helper around `provider_fake_server.py`)
  wrapped around the browser run; the existing `cleanup_browser_series` still handles the approved series.
- `--repeat N` stays meaningful: the provider tests are deterministic, so any failure is real, not flake.

---

## 5. New test files → coverage → tier → budget

| File | Covers | Tier | Est. added runtime |
|---|---|---|---|
| `tests/provider_fake.py` (+ `tests/fixtures/providers/`, `tests/provider_fake_server.py`) | shared fake provider, fixtures, request log, scriptable failures; host entry point for the browser tier | n/a (helper) | ~0s (startup <0.2s) |
| `tests/test_providers_contract.py` | per-adapter search→rank→map, golden-field table, provenance, UA/auth headers | fast | ~6s |
| `tests/test_providers_resilience.py` | 429/`Retry-After`, 5xx retry, timeout/hang, malformed, size cap, HTML strip, fallback | fast | ~4s (uses short waits) |
| `tests/test_metadata_suggest.py` | precedence, merge, locked values, unknown title, Kavita-only precedence | fast | ~4s (one reusable upload) |
| `tests/test_providers_cache_keys.py` | cache hit/TTL/negative-cache, provider-id skip, key redaction/at-rest/opt-in | fast | ~3s (1s TTL window) |
| `tests/browser/suggestion_card.py` | chip + attribution + licence, "Use these" fill, locked field kept, outage fallback, no console errors | browser | browser-tier only |
| `tests/run.sh` (edit) | register the above; host-side fake lifecycle | n/a | — |

**Runtime budget.** The fast tier is ~25s today. The four new fast files add **≤ ~17s**, keeping the fast
tier **≤ ~45s** — target **40–45s**, hard ceiling **60s** — well under a minute, and still the tier to
run on every save. The slow tier gains only the single "apply writes the file" case (< ~10s). Assertions
are batched per upload; TTL uses a 1s configured window with `wait_until` polling rather than sleeps.

---

## 6. Flakiness and compliance checks

Deterministic by construction: fixed fixtures, fixed search terms, no live clocks beyond a short TTL,
`wait_until` instead of sleeps, and teardown in `finally`. Compliance is asserted as first-class tests
(mostly in `test_providers_resilience.py` and `test_providers_cache_keys.py`):

- **Attribution present.** Every suggest response and the review card carry the provider name, a licence
  link (Metron/GCD: CC BY-SA 4.0; MangaDex: credit; Hardcover: cite) and a source URL. Asserted in the
  API test and the browser test. Cover images are **proxied**, not rehosted — assert the card references
  the portal's proxy, and that no provider image bytes are written into files.
- **No accidental bulk sweep.** Providers are only called on an explicit per-card **Suggest**, one lookup
  per review. Assert exactly **one** upstream request per lookup; after a lookup and after a library
  rescan/approval, assert the fixture request **count is unchanged** over a few seconds (no polling, no
  background enumeration, no providers-on-approve).
- **Rate limits honoured.** Tests inspect the fake's received headers/counts: `Retry-After` and
  `X-RateLimit-Remaining` are respected, back-off prevents back-to-back calls, and a rate-limited
  provider yields a "try later" state without a retry storm (asserted via request count and timing).
- **User-Agent set.** Every provider request carries a truthful UA naming the app and project URL (and a
  contact address for Open Library), asserted for each adapter from the fake's recorded headers — the
  requirement MangaDex and Open Library impose in lieu of a key.
- **Plain-text only.** Provider summaries/titles are stored and rendered as plain text (HTML stripped),
  and treated as untrusted; asserted both at the API boundary and in the DOM.
- **No real data leaked into fixtures.** A quick guard (fixture README + a check that fixtures contain no
  provider URLs/keys) keeps the test corpus licence-clean.

---

# Phase 2 — Direct Metadata Providers: Project Plan

**Project:** kavita-companion · **Scope:** roadmap §5 phase 2 · **Date:** 2026-10-16
**Sources:** `docs/roadmap.md` §5, `docs/metadata-providers.md`, `docs/development.md`,
`docs/architecture.md`, `docs/decisions.md`, `CLAUDE.md`.

Phase 1 (Kavita-only `/suggest`) shipped in 0.2.7. Phase 2 adds **direct integration** with external
providers, writing fetched values into ComicInfo.xml (comics) and EPUB OPF (books), under a human
review gate and **without violating provider licences/ToS**. Nothing here is code; it is schedule,
roles, estimates and gates.

---

## 0. Assumptions & estimate method

- Same architecture and workflow: TypeScript/Fastify/SQLite in `src/`, browser code in `web/main.js`,
  Python acceptance tests in `tests/`, work on a branch in `/srv/kavita-test`, verify with
  `tests/run.sh --browser --roles`, merge to `main`, tag → GHCR.
- **Team:** a handful of single-role AI agents plus one human owner/reviewer, coordinated by the
  orchestrator (me). Agents work fast but every deliverable passes human review and integration, so
  the review+rework cost dominates.
- **Estimates are person-days and are estimates, not commitments.** `raw` = agent output before
  review; `realistic` = raw × ~1.8 (review, rework, integration, docs) unless noted. Confidence:
  **H** ±20% · **M** ±40% · **L** ±80%+.
- **Constant rules** (from the research): one lookup per review, never poll; aggressive local cache,
  never a bulk mirror; persist provider IDs to skip re-search; honour `Retry-After`; truthful
  `User-Agent`; proxy cover images; show attribution; auto-apply is never allowed — the reviewer
  confirms every field.

---

## 1. Agent roles

| Role | Owns / does | Not their job |
|---|---|---|
| **Platform Engineer** | W1 framework: adapter interface + registry, config/`.env`, encrypted key storage, cache table + migration, shared HTTP client (timeouts, retry/`Retry-After`, token-bucket rate limit, UA, size caps, HTML strip), provider-ID persistence, review `/suggest` glue. | Provider-specific field mapping. |
| **Adapter Engineer (comics)** | W2 Metron, W3 GCD: API/ingest client, search + match/rank, mapping to ComicInfo fields, per-adapter fixtures. | Framework, UI. |
| **Adapter Engineer (manga)** | W4 MangaDex (UA + image proxy), W5 AniList (GraphQL, transient-cache-only). | Framework, UI. |
| **Adapter Engineer (books)** | W6 Hardcover, W7 Open Library (+ optional PRH): ISBN handling, OPF mapping. | Framework, UI. |
| **Frontend Engineer** | W8 review-card Suggest/Match/Apply UX (multi-provider), W9 metadata-completeness + "needs metadata" queue + companion search/browse. | Adapter internals. |
| **Compliance Reviewer** | W10: attribution text/UI, caching policy, no-bulk-mirror safeguard, key handling policy, licence/ToS gate per provider, legal-pass coordination. Holds a veto on enabling a provider. | Building adapters. |
| **QA Engineer** | W11: fixtures, fake-provider server, contract tests per adapter, fast-tier wiring, browser check; also reviews each WP's tests. | Feature code. |
| **Tech Writer** | W12: `docs/metadata-providers.md` outcomes, `docs/user-guide.md`, `CHANGELOG.md`, release notes, `.env.example` comments, attribution/about copy. | Feature code. |

**Roles the orchestrator (me) keeps:** overall decomposition and sequencing; the **adapter interface
and contracts** as the single source of truth; integration/merge and release control (version bump,
tag, GHCR); arbitration between roles and owner escalations; final review sign-off before merge. I do
**not** own provider-specific implementation or the UI, but no WP is "done" until I have integrated
it and the QA + Compliance reviews have passed.

---

## 2. Work breakdown & estimates (person-days)

| WP | Deliverable | Subtasks (raw) | Raw | Realistic | Conf. |
|---|---|---|---|---|---|
| **W1** | Provider-adapter framework | Interface+registry+capability model 1.5 · config/enable flags/defaults 1.0 · encrypted key storage + admin API 2.0 · cache table+migration+TTL/no-hoard 2.0 · shared HTTP client 2.5 · provider-ID persistence + `/suggest` glue 1.0 | 10 | 18 | M |
| **W2** | Metron adapter (comics) | client 2.5 · match/rank 2.0 · ComicInfo mapping 1.5 · fixtures 1.0 | 7 | 12 | M |
| **W3** | GCD adapter/fallback (comics) | data-source spike+client 2.5 · mapping/search 1.5 | 4 | 8 | **L** |
| **W4** | MangaDex adapter (manga) | client 2.5 · cover image proxy 1.5 · mapping 1.0 · fixtures 1.0 | 6 | 10 | M |
| **W5** | AniList adapter (manga/LN) | GraphQL client 1.5 · match/mapping 1.5 | 3 | 5.5 | M |
| **W6** | Hardcover adapter (books) | client+PAT 2.0 · mapping/OPF 1.5 | 3.5 | 6.5 | M |
| **W7** | Open Library (+ optional PRH) | OL client/mapping 2.0 · PRH client+key flow 2.0 | 4 | 7 | M |
| **W8** | Review-card multi-provider Suggest/Match/Apply UI | provider picker+merge candidates 1.5 · apply-selected-fields 1.0 · source+attribution chips 0.5 · error/offline states 0.5 · multi-provider routing 0.5 | 4 | 7.5 | M |
| **W9** | Search & browse | completeness scoring 1.5 · "needs metadata" queue 1.5 · companion library search/browse 2.0 | 5 | 10 | **L** |
| **W10** | Compliance measures | attribution registry+UI copy 1.0 · caching-policy enforcement 1.0 · no-bulk-mirror safeguard+test 0.5 · key-handling policy 0.5 | 3 | 5.5 | M |
| **W11** | QA harness | fixtures+fake-provider server 2.5 · per-adapter contract tests 1.5 · fast-tier wiring 0.5 · browser check 0.5 | 5 | 9 | M |
| **W12** | Docs + release(s) | user-guide + provider docs 1.5 · CHANGELOG/setup/.env.example 1.0 · per-release notes 0.5 | 3 | 6 | H |

**Totals: raw ≈ 57 person-days · realistic ≈ 105 person-days** (review-inclusive). W1/W8/W11/W12 are
spread across milestones in practice. The realistic figure is deliberately pessimistic: with a small
AI team most of W1/W2 proceeds in parallel, so elapsed calendar time is far below the sum (see §3).
The **largest uncertainties are W3 (GCD has no clean REST API) and W9 (scope)**: treat both as
spikes first.

---

## 3. Dependencies, sequence & milestones

**Hard dependencies**

- **W1 blocks everything.** Adapters (W2–W7) implement the W1 interface; W8/W9 consume it; W11
  fixtures target it.
- W8 needs W1 + at least one working adapter (W2 first).
- W3 reuses W2's match/rank; W5/W7 are secondary/fallback paths, so they can follow their primaries.
- W9 needs W1 (provider-ID persistence) and W8's apply path.
- W10 runs alongside but its **gate must pass before a provider is enabled by default**.
- W11 runs per-WP; W12 per release.

**Critical path:** W1 → W2 → W8 → M1 → (W9, W10) → M6.

| Milestone | Contents | Realistic pd | Calendar* |
|---|---|---|---|
| **M1 — Thin vertical slice** (release 0.3.0) | W1 core, W2 full, W8 v1 (single provider), W11 fixtures+fake Metron, W12 release notes | ~30 | 3–4 wk |
| **M2 — Comics coverage + QA** (0.3.x) | W3 GCD, W1 cache/ID hardening, W8 multi-candidate, W11 full contract harness + fast tier | ~18 | ~2 wk |
| **M3 — Manga** (0.4.0) | W4 MangaDex, W5 AniList, W8 manga routing, tests+browser check | ~16 | ~2 wk |
| **M4 — Books** (0.5.0) | W6 Hardcover, W7 Open Library; **PRH deferred** (opt-in follow-up); OPF/ISBN gap documented, tests | ~14 | ~2 wk |
| **M5 — Search & browse** (0.6.0) | W9 completeness + "needs metadata" queue + companion search/browse | ~10 | ~1.5 wk |
| **M6 — Compliance polish** (0.6.x → 1.0) | W10 final, W12 full docs, harden (**no legal pass** — ComicVine/Google Books excluded) | ~12 | 1.5–2 wk |

\*Calendar assumes ~4–5 agents working in parallel plus the human reviewer; **overall ~11–14 weeks
(≈3 months)** end-to-end, confidence **L**. Sequential execution would be the raw/realistic sum.

---

## 4. Assignment (RACI-ish)

R = does the work · A = accountable (orchestrator unless noted) · C = consulted · I = informed.

| WP | R | A | C | I | Human owner sign-off |
|---|---|---|---|---|---|
| W1 | Platform Engineer | Orchestrator | Compliance, QA, all adapters | — | **Key storage** (`.env` vs encrypted DB) |
| W2 | Adapter Eng (comics) | Orchestrator | Platform, QA | Compliance | Metron as comics default |
| W3 | Adapter Eng (comics) | Orchestrator | Platform, Compliance, QA | Frontend | GCD data-source approach |
| W4 | Adapter Eng (manga) | Orchestrator | Compliance (ToS), QA | — | MangaDex as manga default |
| W5 | Adapter Eng (manga) | Orchestrator | Compliance, QA | — | AniList permitted (no-hoard) |
| W6 | Adapter Eng (books) | Orchestrator | Compliance, QA | — | Hardcover as books default |
| W7 | Adapter Eng (books) | Orchestrator | Compliance, QA | — | PRH opt-in; OL fallback |
| W8 | Frontend Engineer | Orchestrator | all adapters, Compliance, QA | Owner | **Attribution UX wording** |
| W9 | Frontend Engineer | Orchestrator | Platform, QA | Owner | Scope of search/browse |
| W10 | **Compliance Reviewer** | **Owner** | Platform, Frontend, Orchestrator | all | **Compliance review; ComicVine/Google Books excluded (no legal pass)** |
| W11 | QA Engineer | Orchestrator | all | — | — |
| W12 | Tech Writer | Orchestrator | all | Owner | Release notes/version |

**The human owner must decide or sign off:** (1) **Kavita+ vs direct vs both** — *resolved: direct only,
Kavita+ out of scope* (decision 1); (2) **provider enable defaults** (Metron+GCD comics, MangaDex+AniList
manga, Hardcover+Open Library books); (3) **key storage** — *resolved: sealed in `provider_config`, with
an optional `.env` override* (decision 3); (4) **ComicVine and Google Books** — *resolved: excluded, no
legal pass required* (decision 4); (5) **attribution UX**; (6) **each release** (tag/merge to `main`).
Compliance holds a veto on enabling any provider.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Licence/ToS breach** (AniList no hoarding; Metron/GCD covers and ShareAlike) | Compliance gate before enabling (ComicVine/Google Books are excluded, not opt-in); transient cache only where required; central attribution registry; no-bulk safeguard test. |
| **GCD has no stable REST API** (W3) | Timeboxed spike at start of M2; consider dump/CSV ingest; if unworkable, GCD ships as thin fallback or defers — never blocks M1. |
| **Bad matches / polluted files** | Match+rank, show candidate + source, **human confirms every field**; persist provider IDs; never auto-apply. |
| **Provider outage / rate limits** | W1 timeouts, retries, `Retry-After`, token bucket; degrade to blank fields; review never blocks on a lookup. |
| **Secret leakage** | Encrypted at rest like sessions, admin-only routes, no keys in logs, ship no default keys. |
| **SSRF / outbound abuse** | Allow-list provider hosts; size caps; short timeouts (reuse the existing notify SSRF guard). |
| **Scope creep (W8/W9)** | Thin vertical slice (M1) first; per-milestone DoD; owner scope sign-off. |
| **Regression in review/approval path** | Contract tests per adapter + fast tier + browser check run before every merge. |
| **Agent context loss / drift** | Interface + docs land first (W1), fake-provider server as stable target. |
| **ShareAlike/attribution forgotten** | Attribution rendered from adapter metadata, so it cannot silently drop. |

---

## 6. Definition of done — per milestone

- **M1:** a reviewer can search Metron from a comic review card, pick a candidate and apply fields,
  and approval writes them to ComicInfo; key stored encrypted; attribution shown; contract + browser
  tests green; `tests/run.sh --browser --roles` passes; CHANGELOG/docs updated; tagged release.
- **M2:** comics have Metron primary + GCD fallback with failover; contract tests cover every
  registered adapter; fast tier green; caching policy documented and enforced (no bulk mirror).
- **M3:** manga routed to MangaDex primary with AniList for LN/secondary; truthful `User-Agent`;
  covers proxied; AniList used transiently only; browser check green.
- **M4:** books use Hardcover primary + Open Library fallback; ISBN written to OPF; PRH (opt-in)
  supplies imprint/age; tests green.
- **M5:** "needs metadata" queue lists files missing fields; companion search/browse by title,
  creator and provider ID; links into the review card; Kavita-consistent styling.
- **M6:** attribution text/links on card + About; caching and key-handling policies documented and
  tested; no-bulk-mirror safeguard test green; **no legal sign-off is required to ship** (ComicVine and
  Google Books are excluded); compliance measures documented in `docs/compliance.md`; all docs current.
