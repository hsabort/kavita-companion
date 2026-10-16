# R2 — Comic-book metadata providers (raw research)

Bottom line: metron + GCD are license-safe (CC BY-SA 4.0, commercial OK, embedding allowed). ComicVine
= best mainstream coverage but non-commercial + "do not reproduce on any other medium" (tension with
writing ComicInfo.xml). Metron recommended primary; GCD fallback; ComicVine opt-in (admin key).

## ComicVine
- Coverage: mainstream US strongest; broad general; indie/some manga; weak European/BD. Free-text
  person_credits roles. Resources: /search, /volumes, /volume/{id}, /issues, /issue/{id}, /publishers,
  /people, /story_arcs.
- API: REST XML/JSON/JSONP; base https://comicvine.gamespot.com/api/ ; auth ?api_key= ; key: sign up
  then the API page ("You must log in to get a Comic Vine API Key"). limit ≤100 (resources), search ≤10.
- Limits/cost: 200 requests/resource/hour + velocity detection. No paid tier. NON-COMMERCIAL only
  ("Commercial use will result in your API key being revoked").
- Fields: Series=volume.name; Number=issue.issue_number; Title=issue.name; Summary=deck/description;
  Year=cover_date/store_date; Writers..=person_credits roles; Publisher=volume.publisher; NO imprint,
  NO genre (concepts), NO LanguageISO, NO AgeRating; Tags=concepts/aliases. Volume=start_year only.
- Search: two-step volume→issue (/search or /volumes?filter=name:...; /issues?filter=volume:<id>,
  issue_number:<n>).
- ToS: non-commercial; 200/hr; don't build competing product; credit+link back; "Do not edit, manipulate
  or reproduce on any other medium"; revocable. Caching suggested.
- Verdict: legally riskiest for a redistributable tool that writes metadata into files. Optional,
  admin-supplied key, labelled personal/non-commercial, cache aggressively.

## Grand Comics Database (GCD)
- Coverage: worldwide incl. BD/manga; deepest historical. Free-text credits (often ;-separated); many
  narrative fields blank. Fields per issue story: script, pencils, inks, colors, letters, editing,
  genre, characters, synopsis; series indicia_publisher, brand_emblem; rating, keywords.
- API: REST (DRF); base https://www.comics.org/api/ ; no key (anon) or free account raises limit;
  schema at /api/schema/. Endpoints: /api/series/, /api/series/name/<name>/, .../year/<y>/,
  .../issue/<n>/, /api/issue/<id>/, /api/issue/on_sale_weekly/...
- Limits/cost: anon 30/hour; authenticated 2000/day; page size 50. No paid tier. Bulk dumps
  (current.zip / pg-current.zip / current_sqlite.zip / current_name_value.zip), 5-min cooldown.
- Fields (live example issue 256114): Series=series_name; Number=number/descriptor; Title=story title
  (issue title often blank); Volume=volume (free text, often blank); Summary=story_set[].synopsis
  (often empty); Year=key_date; Writer=script; Penciller=pencils; Inker=inks; Colorist=colors;
  CoverArtist=cover story pencils/inks/colors; Publisher=indicia_publisher; Imprint=brand_emblem;
  Genre=genre; Tags=keywords; AgeRating=rating (often blank); LanguageISO not reliable on issue endpoint.
- Search: /api/series/name/<name>/issue/<n>/year/<y>/ (substring + year).
- ToS: content licensed CC BY-SA 4.0; commercial allowed; attribution required; ShareAlike on
  distributed adaptations. Full dumps offered.
- Verdict: strong legal footing, broadest coverage, no key, bulk dump for offline cache. Free-text
  credits need parsing; some fields blank. Excellent provider #2 / fallback (best for pre-1990 & non-US).

## Metron
- Coverage: US mainstream + UK + IT; modern focus; smaller/deeper-less than GCD for old European.
  Structured model: publisher AND imprint, series genres/language(ISO 639-1)/volume/year_began/status,
  issue rating, story arcs/characters/teams/universes, credits (creator+roles), variants, reprints,
  price, upc, isbn, cover image + cover_hash.
- API: REST (DRF); base https://metron.cloud/api/ ; ALL endpoints require auth — Basic or Bearer token
  (account page → API Tokens; multiple, revocable, non-expiring). Free signup. Swagger /docs/, schema
  /api/schema/. Endpoints /api/issue/, /api/series/, /api/creator/, /api/publisher/, /api/imprint/,
  /api/arc/, /api/character/, /api/team/, /api/universe/, /api/role/, /api/credit/, nested lists.
- Limits/cost: free; burst 20/min + sustained 5,000/day; X-RateLimit-Burst-*/Sustained-* headers, 429
  Retry-After. Donors → up to 25,000/day. No conventional paid plan.
- Fields: Series=series.name; Number=number; Volume=series.volume (int); Year=series.year_began /
  cover_date/store_date; Writer/Penciller/Inker/Colorist/CoverArtist=credits (role resource); Publisher
  =publisher.name; Imprint=imprint; Genre=series.genres; Tags=arcs/characters/teams/universes;
  LanguageISO=series.language (ISO 639-1); AgeRating=issue.rating; Summary=issue.desc (often short).
- Search: single request /api/issue/?series_name=...&number=...&series_year_began=... (+publisher_name,
  imprint_name, cover_year/month, upc, sku, store_date_range_*). Cross-IDs cv_id/gcd_id.
- ToS: CC BY-SA 4.0, commercial explicitly allowed; attribution + license link required; ShareAlike on
  distributed adaptations. COVER IMAGES excluded (fair use) — don't rehost. Policy: multi-user apps need
  each user to have their own Metron account (no shared account). Caching + modified_gt sync encouraged.
  Official metron-tagger writes into archives (embedding is intended).
- Verdict: best overall fit — maps nearly all our fields (imprint/genre/language/rating too),
  single-request issue lookup, bearer tokens, embedding-permitted license. Smaller DB than GCD/CV.
  Each install creates its own free account/token; attribution required; don't rehost covers.

## Also-ran
- League of Comic Geeks: no public API (retailer-only), anti-scraping ToS → unusable.
- Comic Book Plus: no API (download site).
- Marvel API: developer portal appears retired (redirects to marvel.com); Marvel-only anyway. DC none.
- MangaDex: free, ~5 req/s per IP, truthful User-Agent, proxy needed (no CORS); manga-oriented, poor
  ComicInfo penciller/inker/colorist mapping.
- AniList: free GraphQL, 90/min (degraded to 30/min), manga metadata; supplement only.
- Open Library (books): free, no key, 1 req/s (3/s with UA+email), dumps; title/authors/publisher/year/
  subjects; no comic roles.
- ComicVerse API: unofficial aggregator over CV/Metron/Marvel/SuperHero; inherits upstream terms.

## Field matrix (our 17 fields)
Series/Number/Publisher: all 3 direct. Volume: Metron direct; CV start_year; GCD free-text. Summary:
CV good; GCD/Metron partial. Year: all. Writer/Penciller/Inker/Colorist: CV roles; GCD free-text; Metron
roles. CoverArtist: all partial. Imprint: Metron only; GCD brand_emblem; CV none. Genre: Metron+GCD;
CV none. Tags: all partial (Metron arcs/etc.). LanguageISO: Metron only. AgeRating: Metron; GCD rating.

## Recommendation
1. Metron primary (map + license + per-install bearer token). Attribution "Comic data from Metron,
   CC BY-SA 4.0". Each install its own free account/token.
2. GCD provider #2 / fallback (no key, CC BY-SA, best pre-1990 & non-US); authenticate for 2000/day;
   parse free-text credits; bulk dump optional.
3. ComicVine opt-in, admin key, labelled personal/non-commercial; cache; never bundle a key. (Not legal
   advice.)
4. Skip LoCG/ComicBookPlus/Marvel/DC. MangaDex/AniList only for a manga path; Open Library optional for
   books.
5. Architecture: single lookup per review, persist results, never poll; Metron list→detail; send UA;
   honor Retry-After/X-RateLimit-*; persist Metron/GCD IDs (+ cv_id/gcd_id). CC BY-SA attribution;
   ShareAlike on distributed data; don't rehost Metron covers.
