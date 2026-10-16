# Provider test fixtures

Hand-written, **synthetic** payloads shaped like the fields each provider adapter reads. They contain
no real provider data, no real names, no URLs and no keys (compliance M9: fixtures are never rehosted
provider content). Edits are reviewable diffs.

Layout: one directory per provider. For the built-in test stub (`PROVIDERS_STUB=true`, W1 framework):

- `stub/search.json` — a search result list (candidates, with a score).
- `stub/record.json` — one full record, with HTML in `Summary` to exercise the plain-text hook.

For the Metron adapter (`PROVIDER_METRON_BASE`, W2) — served for `/api/issue/` and `/api/issue/<id>/`:

- `metron/search.json` — a Metron issue-list page (`results[]`, each with a nested `series`/`publisher`).
- `metron/record.json` — one full issue detail: nested `series` (genres/language/volume/year_began),
  `publisher`, `imprint`, `credits` (creator + roles), `arcs`/`characters`/`teams`, `rating`, `desc`,
  with HTML in `title`/`desc` to exercise the plain-text hook.

`tests/provider_fake.py` serves these and can be scripted (429 + `Retry-After`, 500, oversized body,
HTML) from a test; `tests/test_providers_framework.py` and `tests/test_providers_metron.py` start and
stop it.

For the MangaDex adapter (`PROVIDER_MANGADEX_BASE`, W4) — served for `/manga` and `/manga/<id>`:

- `mangadex/search.json` — a MangaDex collection (`data[]` of entities with localized `attributes`).
- `mangadex/record.json` — one full entity: localized `title`/`description` (with a credit preamble
  and HTML), `year`, `contentRating`, `originalLanguage`, `lastChapter`/`lastVolume` (must NOT map to
  Number/Volume), `tags[]` with `attributes.group`, and `relationships[]` (`author`/`artist`).

For the AniList adapter (`PROVIDER_ANILIST_BASE`, W5) — served for the single GraphQL endpoint `/`:

- `anilist/search.json` — a `{ data: { Media: … } }` search response (the golden media).
- `anilist/record.json` — the same by-id media: `title`/`description`, `startDate`, `genres`,
  ranked `tags`, `staff.edges[]` with `role`, `isAdult`, `countryOfOrigin`, `chapters`/`volumes`.
- `anilist/record-teen.json` — a second media (`isAdult: false`) for the other AgeRating bucket.

For the Hardcover adapter (`PROVIDER_HARDCOVER_BASE`, W6) — served for the single GraphQL endpoint
(`/v1/graphql`), routed on the request body (Typesense search vs by-id `books(where:…)`):

- `hardcover/search.json` — a `{ data: { search: { results: […] } } }` Typesense "Book" response (three
  documents differing by year/title so ranking is deterministic).
- `hardcover/record.json` — the by-id `{ data: { books: [ … ] } }` golden book: a `description` with
  HTML, two `book_series` relations (only one `featured`), `contributions` (authors + an illustrator),
  and a `default_ebook_edition` (publisher, language `eng`, ISBN, pages).
- `hardcover/record-minimal.json` — a sparse book (null summary/series/edition) to prove nulls are skipped.

For the Open Library adapter (`PROVIDER_OPENLIBRARY_BASE`, W7) — served for `/search.json`,
`/isbn/…`, `/books/…`, `/works/…` and `/authors/…`:

- `openlibrary/search.json` — a `search.json` response (`docs[]` of work docs with `author_name`,
  `first_publish_year`, `edition_key`, `language`).
- `openlibrary/work.json` — one work: `description` as an object, `first_publish_date`, `subjects`
  (genre-like + messy), and `authors` as keys.
- `openlibrary/edition.json` / `openlibrary/editions.json` — one edition (`publishers`, `isbn_10`/`isbn_13`,
  `languages` as `/languages/eng`, `works` back-reference); the `editions.json` wraps it in `entries[]`.
- `openlibrary/author.json` / `openlibrary/author-2.json` — the two authors a work resolves by key.
