# R4 — Kavita-native metadata options (raw research), Kavita v0.9.1.4

KEY FINDING: the open-source Kavita server has NO direct third-party metadata integration. External
metadata is exclusively a Kavita+ feature proxied through https://plus.kavitareader.com, gated by a
Kavita+ license. No per-provider API keys. Companion options: (1) detect the license and delegate to
Kavita's providers, or (2) integrate third-party APIs directly, or (3) use an intermediate tool.

## 1. Per-library metadata providers
- Three providers, all Kavita+ only: Hardcover (books/LN/some comics), Mangabaka (manga/webtoons/OEL),
  ComicBookRoundup (comics, follows ComicVine naming). Enum MetadataProvider 2/3/4.
- Valid per library type; series can override (metadataProviderOverride). Discovery:
  GET /api/Library/metadata-providers?libraryType=, GET /api/Library/metadata-enabled-libraries.
- NO per-provider API keys. Kavita calls its own backend plus.kavitareader.com with the instance's
  Kavita+ license key. (Configuration.GetKavitaPlusApiUrl; KavitaPlusApiService.)
- ComicVine survives only as a library TYPE (LibraryType.ComicVine=5) and a stored external id
  (comicVineId), NOT a live provider in v0.9.1.4. AniList/MAL/MangaBaka/Hardcover as metadata are via
  Kavita+; AniList/MAL/Hardcover/MangaBaka also exist as SCROBBLE providers (OAuth). No live MangaDex
  provider.

## 2. Kavita+
- Optional premium subscription run by the lead dev; base product + K+ ("internet facing
  functionalities"). Node-locked to one instance; all users benefit.
- Cost (live /api/license/products): $4.00/month (billingInterval 2) or $46.00/year (billingInterval 3);
  $2 first month code FIRSTTIME. priceAmount/Currency in LicenseInfoDto.
- Adds external metadata (Mangabaka, Hardcover, ComicBookRoundup) with a metadata-controls engine (± mappings,
  whitelists/blacklists, overrides); scrobbling (Hardcover/MAL/AniList/MangaBaka); recommendations,
  reviews, ratings; smart collections; want-to-read sync.
- Metadata controls: GET/POST /api/Settings/metadata-settings (MetadataSettingsDto) — per-field toggles,
  blacklist/whitelist, ageRatingMappings, fieldMappings[], overrides[], personRoles[], filterAboveWeight.
  File-based metadata (ComicInfo/PDF/opf) can also be routed through this mapping engine.
- License REQUIRED: [KPlus] filter → HTTP 403 (kavitaplus-restricted) without an active license.
  Node-locked; supports only latest 3 stable versions; rate limit 50 metadata match/refresh per 24h
  (SeriesPerRefresh=40 leaves overhead for scans); annual $46/yr cheaper.

## 3. Endpoints the companion could read (all local Kavita; "K+?" = populated by Kavita+)
- GET /api/Series/metadata?seriesId= → SeriesMetadataDto (summary, genres, tags, people roles, ageRating,
  releaseYear, language, counts, publicationStatus, webLinks, per-field *Locked). Reflects K+ indirectly.
- POST /api/Series/metadata → update (admin).
- GET /api/Series/{seriesId} → SeriesDto incl. external IDs: aniListId, malId, hardcoverId, metronId,
  comicVineId, mangaBakaId, mangaBakaEditionId, cbrId, dontMatch, isBlacklisted, metadataProviderOverride.
- GET /api/Series/match-info?seriesId= → MatchSeriesInfoDto ([KPlus]+admin, 403 without license).
- POST /api/Series/match → MatchSeriesResultDto{provider, matches:[{series:ExternalSeriesDetailDto,
  matchRating}]}; 1-min cache; [KPlus]+admin.
- POST /api/Series/update-match?seriesId=&provider= → enqueue FixSeriesMatch (background). [KPlus]+admin.
- POST /api/Series/dont-match. [KPlus]+admin.
- GET /api/Series/all-related?seriesId= → RelatedSeriesDto grouped by relation (local targets).
- GET /api/Series/related?seriesId=&relation=.
- GET /api/Series/series-detail?seriesId= → SeriesDetailDto (no external metadata).
- GET /api/Metadata/series-detail-plus?seriesId=&libraryType= → SeriesDetailPlusDto{recommendations,
  reviews[], ratings[], series:ExternalSeriesDetailDto}; refreshes if local >2 weeks; OnDemand path
  bypasses the rate limit. Richest external read.
- GET /api/Chapter/chapter-detail-plus?chapterId= → issue-level ratings/reviews.
- GET /api/Metadata/* lookup lists (genres, tags, people, people-by-role, age-ratings, publication-status,
  languages, all-bcp47-languages, language-title, ...-with-counts); PersonDto has aniListId/malId/
  hardcoverId/roles/coverImage/aliases.
- GET /api/Manage/matched-series-counts; POST /api/Manage/series-metadata (paged match status). admin.
- GET/POST /api/Settings/metadata-settings. admin.
- License: GET /api/License/has-license, GET /api/License/valid-license?forceCheck=,
  GET /api/License/info?forceCheck=, GET /api/License/provider-health?forceCheck=.
- KavitaPlusAudit: POST /api/kavita-plus-audit/entries (category/status/diff/errors/canRetry),
  GET /entries/series/{seriesId}, /my-activity, /my-stats, /stats. Rich audit trail.

## 4. On-demand fetch/match
- POST /api/Series/match (interactive; free-text query or short codes anilist:123 / hardcover:slug /
  cbr:slug; cached 1 min).
- POST /api/Series/update-match (enqueue FixSeriesMatch; refetch metadata+covers).
- GET /api/Metadata/series-detail-plus runs TryMatchAndLoadMetadataForSeries(OnDemand) — bypasses the
  50/24h limit by design (a code TODO questions this).
- GET /api/Series/external-series-detail?seriesId=&aniListId=&malId=&mangaBakaId=&hardcoverId=&recommendedSeriesId=
  ([KPlus], 15-min cache).
- Background: KavitaPlusDataRefresh job → FetchExternalDataTask (subject to 50/24h).
- CAVEATS: POST /api/Series/refresh-metadata and /api/Library/refresh-metadata are MISNAMED — they run
  cover generation, NOT a metadata pull. match/match-info/update-match/dont-match/external-series-detail
  → 403 without license; match* also admin. Rate limit 50/24h for background. External metadata
  ValidUntilUtc +30 days; match cache 1 min; series-detail-plus refreshes >2 weeks; auto-select on 100%
  or single ≥90% match else admin. Version window (latest 3 stable) → license can lapse on upgrade.
  Upstream providers go down (AniList historically).

## 5. Verdict
- Read (already): GET /api/Series/metadata (K+-written values), series list for external IDs. Add:
  /api/Metadata/series-detail-plus, /api/kavita-plus-audit/entries/series/{id}, Manage endpoints.
- Trigger: POST /api/Series/match + update-match (admin) fits "review → correct before ingest", but needs
  the series to exist in Kavita (a new upload must be scanned first).
- Tradeoffs: Kavita+ = low effort/no keys, but low control, $4/mo per server, node-locked, latest-3-
  versions window, no ComicVine/MangaDex/AniList metadata, closed backend. Direct APIs = free/cheap,
  high control, more effort/ToS.

## 6. Intermediate tools
- Komf — separate server, listens to Kavita Series Add, scrapes configurable sources, writes Kavita API
  or ComicInfo.xml. Kavita wiki warns it "no longer works reliably with Kavita". Closest analogue.
- ComicTagger — desktop tagger with talker plugins: ComicVine, Metron, GCD, MangaBaka, Kitsu, MangaDex,
  MangaUpdates, MAL, AniList, Marvel, ANN; writes CBZ/ComicInfo. Good reference implementation.
- Manga-Manager — GUI/CLI; scraping limited to AniList and MangaUpdates.
- Calibre — EPUB/OPF metadata + "Save to Disk" templates for Kavita folder layout (not a scraper).
- Metron — self-host-friendly comic DB; ComicTagger talker; Kavita stores metronId though it isn't a
  selectable provider.
- Mylar3 — writes ComicInfo.xml (relevant to Kavita's ComicVine library type).
- Kavita+ is effectively the aggregate layer for the supported case (MangaBaka+Hardcover+ComicBookRoundup
  behind one licensed API).
