# R1 — Manga/anime metadata APIs (raw research)

Shaping caveat: all four are manga/anime/LN databases. NONE exposes ISBN, Publisher, Imprint, or
granular creator roles (Penciller/Inker/Colorist/CoverArtist). Series/Title/Summary/Year/Genre/Tags/
Writer are well covered for Japanese-origin works.

## MangaDex
- Coverage: manga + manhwa/manhua + doujin, many languages; scanlation-centric; weak on LN/print.
- API: REST OpenAPI https://api.mangadex.org ; public read needs NO auth; write = OAuth2 personal client.
  MANDATORY truthful User-Agent; no CORS for third parties (must proxy server-side); no image hotlinking
  (proxy images).
- Limits: ~5 req/s per IP; 429; persistent → temporary 403 ban. offset+size ≤ 10000, size ≤ 100 typical.
- Fields: Series=title(localized)+altTitles; Number/Volume=lastChapter/lastVolume (often empty strings);
  Summary=description(localized); Year=year; Writer/Penciller=author/artist relationships (ONLY 2 roles);
  Genre=tags group "genre"; Tags=tags (groups genre/theme/format/content, rich); Language=
  originalLanguage/availableTranslatedLanguages; AgeRating=contentRating(safe/suggestive/erotica/
  pornographic); Cover=cover_art → uploads.mangadex.org/covers/... (proxy). NO publisher/imprint/ISBN.
- Search: /manga?title= (substring, order[relevance]), authors[], year, includedTags[], status[],
  contentRating[], ids[]. links{} carries cross-IDs (mal, al, kt, mu…) — great for reconciliation.
- ToS: MUST credit MangaDex; CANNOT run ads/paid services off it; donations OK; caching expected
  (Cache-Control). Non-profit intent.
- Verdict: best primary for manga. No auth, good fields, cross-IDs. Needs proxy + User-Agent +
  attribution.

## AniList
- Coverage: anime + manga + LIGHT NOVELS (format:MANGA/NOVEL/ONE_SHOT); curated, high quality; tags
  structured/ranked; staff roles captured. 18+ entries exist.
- API: GraphQL POST https://graphql.anilist.co ; reads need NO auth; OAuth only for private/mutations;
  no API key.
- Limits: free; 90/min documented, currently degraded to 30/min (live X-RateLimit-Limit: 30) + burst
  limiter; 429 Retry-After. No paid tier; commercial licence only required above $150/mo revenue.
- Fields: Title=title{romaji,english,native}+synonyms; Number/Volume=chapters/volumes (frequently null);
  Summary=description (use asHtml:false — HTML); Year=startDate.year; Writer/etc=staff(edges role,name)
  (roles like "Story & Art", not pencil/ink/colour); Genre=genres[]; Tags=tags[]{name,rank,category};
  Language=countryOfOrigin (JP/KR/CN/TW); AgeRating=isAdult (bool); Cover=coverImage/banner. NO ISBN
  (confirmed: no such field), NO publisher/imprint.
- Search: Media(search:"…", type:MANGA) relevance-ranked; idMal cross-ref; externalLinks. Human
  confirmation advised (sequels/spin-offs).
- ToS: STRICTEST. Non-commercial; using the API "as a backup or data storage service" prohibited;
  hoarding/mass collection prohibited; competing tracker services may not use the data; naming rules.
  Practical: tens of lookups/day + transient cache is fine; don't bulk-mirror.
- Verdict: excellent secondary + best for light novels; one query gets everything; degraded 30/min;
  null counts; no ISBN/publisher; strict ToS.

## Jikan (unofficial MyAnimeList)
- Coverage: scrapes MAL (manga/LN/manhwa + anime). Broad; unofficial.
- API: REST https://api.jikan.moe/v4 ; NO auth, GET-only, read-only; no key.
- Limits: free; 60/min, 3/s, unlimited/day; 24h cache + ETag/If-None-Match → 304.
- Fields: Title=title/title_english/title_japanese/synonyms/titles[]; Number/Volume=chapters/volumes;
  Summary=synopsis/background; Year=published.prop.from.year; Writer=authors[] (MAL merges author+artist,
  NO roles); Genre=genres[]/explicit_genres[]; Tags=themes[]/demographics[]; Cover=images; Status; Type
  (Manga/Novel/Light Novel/One-shot/Doujinshi/Manhua/Manhwa/OEL). NO LanguageISO, NO manga AgeRating,
  NO ISBN, NO publisher/imprint.
- Search: /manga?q= (type/status/dates/genres/letter/order_by/sfw); /manga/{id} and /full (adds
  relations/external). Resolve via MangaDex links.mal or AniList idMal.
- ToS: Jikan software MIT, but DATA is MAL's (scraped); MAL ToS prohibits automated collection; no
  clean data licence or redistribution grant.
- Verdict: free fallback / MAL-id resolver; simplest; unofficial + flaky; no roles/age/ISBN; grey licensing.

## Kitsu
- Coverage: anime/manga/manhua/manhwa/novel/oel/oneshot/doujin (subtype); community-edited, uneven
  (chapterCount/volumeCount/ageRatingGuide null on One Piece). NSFW hidden when unauthenticated.
- API: REST JSON:API https://kitsu.io/api/edge ; public GET no auth; app registration unimplemented;
  OAuth only for writes.
- Limits: NOT documented; no X-RateLimit-* headers; treat as unknown (fair use + cache).
- Fields: Title=canonicalTitle/titles/abbreviatedTitles; Number/Volume=chapterCount/volumeCount (often
  null); Summary=synopsis/description; Year=startDate; Writer/etc=mangaStaff role + people.name
  (comma-separated roles, not pencil/ink/colour); Genre=genres/categories; Tags=categories; AgeRating=
  ageRating(G/PG/R/R18)+ageRatingGuide; Cover=posterImage/coverImage. NO LanguageISO/publisher/ISBN.
- Search: filter[text] FUZZY (typo-tolerant), filter[slug] exact, include=categories,mangaStaff.person;
  page[limit] max 20. People have malId; mappings relationship.
- ToS: NO attribution/caching/redistribution/commercial clauses in docs; kitsu.io/terms is an SPA (no
  machine-readable ToS). Code repos Apache-2.0 (code only, not data). Assume all-rights-reserved.
- Verdict: last-resort filler; don't trust counts; no licence statement.

## Comparison
Rate limits: MangaDex ~5/s/IP; AniList 90/min (now 30) + burst; Jikan 60/min 3/s; Kitsu undocumented.
None has a paid tier (AniList commercial licence >$150/mo). Creator roles: only author/artist or staff
(no pencil/ink/colour/cover). Volume/chapter counts: Jikan ✅; MangaDex/AniList/Kitsu often empty/null.
Age rating: MangaDex contentRating, Kitsu ageRating, AniList isAdult, Jikan none. ISBN/publisher/imprint:
absent everywhere. Cross-IDs help reconciliation. ToS strictness: AniList high; MangaDex medium (credit,
no ads); Jikan grey (MAL data); Kitsu undefined.

## Recommendation
1. MangaDex primary for manga (User-Agent, server-side proxy, attribution).
2. AniList primary for light novels, secondary for manga (human-confirm candidates; no permanent mirror).
3. Jikan fallback / MAL-id resolver.
4. Kitsu last-resort filler.
Do NOT expect these to fill Publisher/Imprint/ISBN/Penciller/Inker/Colorist/CoverArtist — pair with a
book source (Hardcover/Open Library/ISBNdb) and a Western-comics source (Metron/GCD/ComicVine).
