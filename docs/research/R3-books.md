# R3 — Book/EPUB metadata sources (raw research)

Recurring theme: no free source gives all fields. ISBN/Title/Author/Publisher/Year broadly available;
Series/Volume and Genre/Tags weak everywhere except Hardcover (and PRH for its own catalogue); Imprint
only explicit in PRH; AgeRating essentially absent.

## Google Books
- Coverage: tens of millions; trad/indie/self-pub + much comics/manga. Uneven quality; duplicate
  records; auto-translated titles/descriptions. Google: "we license much of the data… not ours to
  distribute"; API "not intended… as a replacement for commercial services".
- API: REST https://www.googleapis.com/books/v1/volumes ; GET /volumes?q= ; GET /volumes/{id} ; API key
  (Cloud Console → Credentials → API key) for public data; OAuth for private. Free.
- Limits: no numeric limit in docs; per-project Cloud Console quota, long-standing default ~1,000/day
  (raiseable). maxResults max 40 (default 10); startIndex paging.
- Fields: title, subtitle, authors[], publisher, publishedDate, description, industryIdentifiers
  (ISBN_10/13), pageCount, categories[], mainCategory, averageRating, language (ISO-639-1), imageLinks.
  NO series/volume field. No AgeRating. Search supports intitle:/inauthor:/inpublisher:/subject:/isbn:/
  lccn:/oclc/, langRestrict, printType, orderBy.
- ToS (important): Books API Terms — may not charge users without agreement; Google APIs ToS §5(e) —
  do not scrape/build databases/make permanent copies, or cache longer than the cache header permits;
  no redistribution; delete cached content on termination.
- Verdict: fallback ISBN/metadata only; transient caching; not a system of record (1,000/day, no series).

## Open Library
- Coverage: 40M+ (library MARC); strong trad/literary/non-English; weaker indie + series structure;
  noisy community subjects. Monthly dumps.
- API: REST https://openlibrary.org ; GET /search.json?q= ; GET /isbn/{isbn}.json → /books/{OLID}.json ;
  GET /works/{OLID}.json. No key; identify with User-Agent + email.
- Limits: free; 1 req/s default, 3 req/s identified; "not intended… as a data backend"; use dumps for bulk.
- Fields: work: title, author_name, first_publish_year, subjects, key. edition: publishers, publish_date,
  isbn_10/isbn_13, languages (3-char MARC), number_of_pages, description, subjects/subject_places/
  subject_people/subject_times, covers, physical_format, oclc_numbers, dewey_decimal_class. Series
  inconsistent.
- Search: title:/author:/publisher:/language:/subject:/isbn:/first_publish_year:, sort/lang/limit/offset.
- ToS: IA "does not assert any new copyright… There may be existing rights issues"; IA Terms apply.
- Verdict: best free "ISBN → title/author/publisher/year/subjects/description"; caching-friendly if
  identified; gaps in series/volume + genre cleanliness.

## Hardcover
- Coverage: curated modern catalogue with librarian standards for manga/light novels (series naming,
  volume numbering) and comics; rich genres/moods/tags. Beta; thin for some newer/indie.
- API: GraphQL POST https://api.hardcover.app/v1/graphql (Hasura); Authorization: Bearer <token>;
  Personal Access Tokens free at https://hardcover.app/account/api (scopes + expiry); OAuth for
  multi-user apps.
- Limits: free 5,000/day, 60/min, burst 10; Supporter 50,000/day, burst 15; each top-level field = 1
  request; 30s query timeout (search 2s); RateLimit / Retry-After headers.
- Fields: books: title, subtitle, description, alternative_titles, genres, moods, tags/taggings, isbns,
  pages, release_date/year, featured_series + featured_series_position, author_names/contributions,
  rating. editions: isbn_10/13, publisher, language, pages, edition_format, country, release_date.
  series: name, author_name, books_count, books.
- Search: Typesense search(query, query_type, per_page, page, sort, fields, weights, typos); query_type
  ∈ author/book/character/list/prompt/publisher/series/user; typo tolerance.
- ToS: no LLM training use; commercial/public products may not use user-owned data; aggregate data with
  attribution; image use needs a DMCA policy. Tokens per-account.
- Verdict: BEST free for Series/Volume, genres, tags, descriptions (books/manga/LN and many comics).
  GraphQL heavier; treat as beta. Primary enrichment for EPUB OPF + strong secondary for comics.

## ISBNdb (paid)
- Coverage: ~122M; trad/non-English/rare; aggregated, not independently verified.
- API: REST https://api2.isbndb.com ; Authorization: YOUR_REST_KEY (header only); GET /book/{isbn},
  POST /books, GET /books/{query}, /search/books, /author|/publisher|/subject/{name}, /feeds/books/updates,
  /key, /stats.
- Cost: NO free API tier (free account = website lookups only). Basic $14.99/mo 5,000/day 100 bulk/call
  1/s; Premium $35.99/mo 15,000/day 1,000 3/s; Pro $99.99/mo 50,000/day 1,000 5/s; Academic $7.50.
  Annual $149/$359/$999; 7-day Basic trial. pageSize ≤100; search paging stops at 10,000.
- Fields: ~19: ISBN10/13, title, author, pub date, publisher, binding, pages, price, cover thumb,
  language, edition, format, synopsis, subject, weight, dimensions. No imprint, no series/volume, no age.
- ToS: non-exclusive licence to use in own products + cache WHILE subscribed; may NOT redistribute/
  sublicense; no "substantial part" (>1,000 records to a third party cumulatively over 12 months); DELETE
  all data within 30 days of termination; no scraping.
- Verdict: good breadth + simple REST, but recurring cost + record ceiling + delete-on-cancel awkward
  for a self-hosted portal that caches. Only for deep out-of-print/non-English.

## Penguin Random House (Enhanced PRH API)
- Coverage: PRH-owned/distributed imprints ONLY (Penguin, Random House, Knopf, Crown, DAW, Berkley/NAL,
  Dark Horse distribution…). Publisher-authoritative, pristine.
- API: REST https://api.penguinrandomhouse.com/resources/v2/title/domains/{domain}/titles/{isbn}?api_key= ;
  /search (Solr) + /search/predictive. Free registration; keys require MANUAL ACTIVATION (hours–7+ days).
- Limits: free; no published rate limits (be polite).
- Fields: isbn, isbnHyphenated, title, subtitle, author, onsale, format, division, IMPRINT (explicit),
  pages, age/grade (AgeRating proxy), subjects (BISAC codes+labels), saleStatus, language, seriesNumber,
  subseries, workId, cover. /titles/{isbn}/authors|categories|imprints|series|works.
- Search: Solr with ISBN/work/author/series/imprint/category facets; predictive typeahead.
- ToS: not published on dev site; assume no bulk redistribution.
- Verdict: ONLY source with a true Imprint AND a real AgeRating signal (age/grade) + BISAC genres +
  seriesNumber. Perfect ISBN-keyed enrichment for PRH titles; useless outside PRH.

## BookBrainz
- Coverage: open MusicBrainz-style DB (books/magazines/journals); explicitly ALPHA; thin but structured
  (Author/Edition/EditionGroup/Work/Publisher/Series). Weekly Postgres dumps.
- API: REST https://api.bookbrainz.org/1/ (OpenAPI); no key; /search?q=&type=&size=, /author/{bbid},
  /edition/{bbid}(/identifiers), /work/{bbid}, /edition-group/{bbid}, /publisher/{bbid}, /series/{bbid}.
- Limits: free; no published limits; dumps for bulk.
- Fields: edition authorCredits.names[], languages[], publishers[].name, releaseEventDate, editionFormat,
  pages, dimensions; identifiers → ISBN-10/13. No age rating.
- Licence: core data CC0; other public data CC BY-SA.
- Verdict: cleanest licence, free, no key — but sparse/alpha. Optional attribution-free fallback.

## Inventaire
- Coverage: book social/federation on Wikidata; good translations, work/edition identity, publishers,
  series, summaries; coverage skews to Wikidata/OL; not a comics source.
- API: REST https://inventaire.io/api (OpenAPI); GET /data/isbn?isbn=,
  /entities/by-uris?uris=isbn:…&attributes=…, /data/summaries?uri=&langs=, /search?types=works&search=;
  no key for public reads.
- Fields: ISBN → Wikidata entity: labels, descriptions, P50 author, P179 series / P629 part-of, P123
  publisher, P577 date, genres, language, image; /data/summaries by language.
- Licence: Inventaire data + wiki CC0; Wikidata CC0.
- Verdict: free/permissive; good for summaries/translations/series links; niche. Secondary.

## Not viable
- WorldCat (OCLC): paid subscription; Search API v1 support ended 2024-12-31.
- OverDrive/Libby: partner approval only.
- Kobo: no public metadata API.
- Also: Goodreads API closed to new keys; LibraryThing members-only. Wikidata (CC0) is a free backbone.

## Comparison (free limits)
Google Books ~1,000/day, no permanent copies; Open Library 1/s (3/s identified); Hardcover 5,000/day
60/min; ISBNdb PAID; PRH free (manual key activation); BookBrainz free CC0; Inventaire free CC0.

## Verdict for kavita-companion
1. Books primary: Hardcover first (series/volume, genres, tags, descriptions incl. manga/LN), Open
   Library second (long tail trad/non-English).
2. PRH ISBN-keyed enrichment when it matches (only true Imprint + AgeRating proxy + BISAC + seriesNumber).
3. Google Books last-resort, transient cache only (ToS forbids permanent copies; 1,000/day).
4. BookBrainz / Inventaire optional CC0 backfills (thin).
5. Skip ISBNdb unless deep out-of-print/non-English needed (fee + >1,000-record + delete-on-cancel).
   Skip WorldCat/OverDrive/Kobo entirely.
6. Manual override needed for AgeRating (except PRH) and Imprint (except PRH); make Series/Volume an
   explicit choice among Hardcover candidates.

Suggested per-field precedence: ISBN/Language/Year ← any; Title/Author/Publisher/Summary ← Hardcover →
Open Library → Google Books; Series/Volume/Genre/Tags ← Hardcover → (PRH for PRH) → Inventaire/
BookBrainz; Imprint/AgeRating ← PRH only, else manual.
