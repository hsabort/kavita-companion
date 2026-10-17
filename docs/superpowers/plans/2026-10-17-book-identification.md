# Book identification (title-first) + staged rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make book uploads identify reliably by searching providers with the book's *title* (series passed as a hint), and normalise the staged file to a canonical name before the review card is built.

**Architecture:** Identification stays derived from Kavita's own parser + embedded EPUB metadata, but gains a pure filename-guess layer (`src/identify.ts`) and a media-aware search key. Comics/manga keep `Series` as the key; books send `Title` as the key plus `series` as an optional hint. Once a name is known, the staged file is renamed to `pending/<id> <canonical>.<ext>` and the canonical name is what feeds `parseName` and the approval plan.

**Tech Stack:** TypeScript (Fastify, better-sqlite3) compiled to `dist/`; vanilla JS portal (`web/main.js`); Python acceptance tests against the test stack (`tests/`, `tests/run.sh`); Kavita REST API.

**Spec / decision record:** This plan implements the decision record at the end of this file (from the 2026-10-17 product review + the interactive decision session). Review finding it resolves: *book uploads with good names fail to identify* (see `docs/reviews/2026-10-17-product-review.md` §2).

## Global Constraints

- Kavita `LibraryType`: Manga=0, Comic=5, Book=2, LightNovel=4. Book media = `"book"` (`review.ts:211-215`).
- Book providers and order: **Hardcover → Open Library**; both search by `query.title`.
- Attribution/licence must keep travelling (card "Applied from …", About → Metadata sources). Never regress `attributionFor`.
- No bulk crawl: the per-review / no-bulk safeguard (`review.ts:268-276`, M6) stays true for every existing path.
- Nothing here writes to a Kavita library folder except the existing approval path.
- Provider keys are never logged or returned; tests use the fake (`tests/provider_fake.py`).
- Portal copy is plain language, no jargon (existing style).
- Work happens in the **test worktree** `/srv/kavita-test` (branch `develop`); live `/srv/kavita` is untouched until an explicit deploy.
- Fast tier (`tests/run.sh --fast`) must stay write-free; anything that writes goes in the slow tier.

## Review Focus

Inputs/conditions the decision record implies but no feature statement spells out. Each gets a test in the owning task.

1. A bare title with no metadata (`Dune.epub`) — must still search by the title, not an empty key.
2. An author-only or unparseable name (`Brandon Sanderson.epub`) — must not send an author-only string as the title, and must not send an empty key.
3. A title that contains a hyphen or is a number (`Catch-22.epub`, `1984.epub`) — the splitter must not shred a real title or invent a series.
4. A standalone book (no series) — must not be forced into a series folder.
5. Provider down / no match — the card must show the error/empty state and leave the staged file unchanged (no partial rename).

---

### Task 1: Filename → title/series guess (pure helper + book defaults)

**Files:**
- Create: `kavita-companion/src/identify.ts`
- Modify: `kavita-companion/src/review.ts` (`defaultsFor`, ~139-167)
- Test: `tests/test_book_identification.py` (new)

**Interfaces:**
- Produces: `guessFromFilename(filename: string): { title?: string; series?: string; number?: string; author?: string }`
- Produces: `bookMediaDefaults(embedded: Metadata, filename: string): { Series?: string; Title?: string; Number?: string }` (embedded wins; guess fills the gaps; never returns an empty `Series`/`Title` string)

- [ ] **Step 1: Write the failing test**

In `tests/test_book_identification.py`, upload to the Books library (`library_ids()["Books"]`) and read `GET /api/review`:

```python
# Dune.epub           -> defaults.Title "Dune",  no series
# Mistborn 01 - The Final Empire.epub -> Title "The Final Empire", Series "Mistborn", Number "01"
# Brandon Sanderson - The Final Empire.epub -> Title "The Final Empire", Series "-" (author kept separately)
# Catch-22.epub       -> Title "Catch-22", no series
# 1984.epub           -> Title "1984", no series
# an EPUB with <dc:title>Dune</dc:title> + calibre:series "Dune" / index "1" -> embedded wins
check("a bare title becomes the book Title", item_defaults(upload_id)["Title"] == "Dune", ...)
check("a series-prefixed name splits into Series/Number/Title", ..., ...)
check("an author-prefixed name keeps the title clean", ..., ...)
check("a hyphen in a title is not a series separator", item_defaults(u2)["Title"] == "Catch-22", ...)
check("a numeric title is not treated as a number", item_defaults(u3)["Title"] == "1984", ...)
check("embedded metadata wins over the filename guess", ..., ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tests/run.sh --fast --only test_book_identification`
Expected: FAIL — book `defaults.Title` is empty / `Series` is the raw filename base.

- [ ] **Step 3: Implement `guessFromFilename` and `bookMediaDefaults` in `kavita-companion/src/identify.ts`**

Rules (order matters; the separator is ` - ` **with spaces**, so `Catch-22` never splits):
1. strip the extension; trim.
2. `^(?<series>.+?)\s+(?<num>\d{1,4}(?:\.\d+)?)\s+-\s+(?<title>.+)$` → series/num/title, then strip a trailing ` (... #n)` / `[...]` from the title.
3. `^(?<series>.+?)\s+#(?<num>[0-9.]+)$` → series/num (no title).
4. `^(?<num>\d{1,4})\s+-\s+(?<title>.+)$` → num/title.
5. `^(?<author>[^\d]+?)\s+-\s+(?<rest>.+)$` → author + recurse on `rest`; if `rest` yields no series, `title = rest`, keep `author`.
6. else → `{ title: base }`.

`bookMediaDefaults`: `{ ...guess, ...embedded }`, then drop empty strings so `Series`/`Title` are never `""`. In `defaultsFor`, for `mediaForLibraryType(libraryType) === "book"`, use `bookMediaDefaults(inspection.embedded, row.filename)`; the existing comics path is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `tests/run.sh --fast --only test_book_identification`
Expected: PASS (all six checks).

- [ ] **Step 5: Commit**

```bash
git add kavita-companion/src/identify.ts kavita-companion/src/review.ts tests/test_book_identification.py
git commit -m "books: derive Title/Series/Number from the filename when the file is bare"
```

---

### Task 2: Title-first search key with a series hint

**Files:**
- Modify: `kavita-companion/src/providers/types.ts` (add `series?: string` to `MatchQuery`)
- Modify: `kavita-companion/src/review.ts` (`matchFor`, ~277-329; media-aware key)
- Modify: `kavita-companion/src/providers/hardcover.ts` (`search`/`toCandidate`)
- Modify: `kavita-companion/src/providers/openlibrary.ts` (`search`/`toCandidate`)
- Test: `tests/test_book_identification.py` (extend) and `tests/test_providers_hardcover.py` / `test_providers_openlibrary.py` (extend)

**Interfaces:**
- Consumes: `MatchQuery` gains `series?: string`.
- Produces: for `media === "book"`, `query.title = overrides.series ?? defaults.Title ?? defaults.Series`, `query.series = defaults.Series` (never a raw author string; when no title can be derived, `query.title` falls back to `defaults.Series`).
- Produces: book adapters treat `query.series` as a ranking hint only (`nameEq`/`nameNear` unchanged; a bonus when the candidate's series matches `query.series`), and use it as the search term **only when `query.title` is empty**. Still exactly **one** search per provider.

- [ ] **Step 1: Write the failing test**

```python
check("a book searches by its Title, not its Series",
      body["query"]["title"] == "The Final Empire" and body["query"]["series"] == "Mistborn", str(body["query"]))
check("the book provider is asked once", fake_book.count_exact("/search.json") == 1, ...)
check("a candidate from the matching series ranks above a same-title decoy",
      candidates[0]["externalId"] == "OL…W", str(candidates[:2]))
check("an author-only name does not search the author as the title",
      body2["query"]["title"] != "Brandon Sanderson", str(body2["query"]))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tests/run.sh --fast --only test_book_identification`
Expected: FAIL — `query.title` is `"Mistborn"` (or the author string) and the fake gets a series query.

- [ ] **Step 3: Implement the media-aware key and the hint**

In `matchFor`, choose `title`/`series` by `mediaForLibraryType(libraryType)` (books: Title-key as above; comics/manga unchanged). Add `series` to the `MatchQuery`. In each book adapter: keep the single `search` call; add `seriesEq` to `score` in `toCandidate` and use `query.series` as the query string only when `title` is falsy.

- [ ] **Step 4: Run test to verify it passes**

Run: `tests/run.sh --fast --only test_book_identification && tests/run.sh --fast --only test_providers_hardcover && tests/run.sh --fast --only test_providers_openlibrary`
Expected: PASS; the existing comic/manga match tests still pass (`test_providers_match`, `test_providers_metron`, `test_providers_mangadex`).

- [ ] **Step 5: Commit**

```bash
git add kavita-companion/src/providers/types.ts kavita-companion/src/review.ts kavita-companion/src/providers/hardcover.ts kavita-companion/src/providers/openlibrary.ts tests/
git commit -m "books: search providers by Title, with the series as a ranking hint"
```

---

### Task 3: One canonical book name, shared by the card and approval

**Files:**
- Modify: `kavita-companion/src/identify.ts` (add the builder)
- Modify: `kavita-companion/src/review.ts` (`planApproval` ~486-523; `defaultsFor` to expose the proposed name)
- Test: `tests/test_review.py` (extend, slow tier)

**Interfaces:**
- Produces: `canonicalBookName(meta: { Series?: string; Number?: string; Title?: string }, opts: { author?: string }): { series: string; filename: string }` — series book → `series = Series`, `filename = "<Series> #<n> - <Title>.epub"`; standalone → `series = author || Title`, `filename = "<Title>.epub"`; everything `safeSegment`-ed.
- Consumes: `defaultsFor` gains a `proposedName` in its return so the card shows the exact destination.

- [ ] **Step 1: Write the failing test**

In `tests/test_review.py` (slow), approve a book with Series "Mistborn", Number "1", Title "The Final Empire" and assert the library file exists at `<Books>/Mistborn/Mistborn #1 - The Final Empire.epub`; approve a standalone ("Dune", no series) and assert `<Books>/Frank Herbert/Dune.epub`.

- [ ] **Step 2: Run test to verify it fails**

Run: `tests/run.sh --slow --only test_review`
Expected: FAIL — the file lands as `<series>/<raw upload name>.epub`.

- [ ] **Step 3: Implement `canonicalBookName` and use it**

`planApproval` for book kind calls `canonicalBookName(metadata, { author: metadata.Writer })` to derive `seriesName` (for the folder) and `filename`; comics keep the current `Series`-folder + given-filename rule. Return the derived name from `defaultsFor` as `proposedName` so the card and the approval agree.

- [ ] **Step 4: Run test to verify it passes**

Run: `tests/run.sh --slow --only test_review`
Expected: PASS; comics approvals still land under `<Series>/<name>.cbz`.

- [ ] **Step 5: Commit**

```bash
git add kavita-companion/src/identify.ts kavita-companion/src/review.ts tests/test_review.py
git commit -m "books: name approved files <Series> #<n> - <Title>.epub (standalone: <Title>.epub)"
```

---

### Task 4: Rename the staged file, then re-parse

**Files:**
- Modify: `kavita-companion/src/uploads.ts` (`checkCompletedUpload` ~302-334; `resumeInterruptedChecks` ~337-347; withdrawal ~427-433)
- Modify: `kavita-companion/src/review.ts` (`defaultsFor`: parse the canonical name; `reviewItem` to surface `stagedName`)
- Test: `tests/test_book_identification.py` (extend)

**Interfaces:**
- Consumes: `canonicalBookName` (Task 3), `guessFromFilename` (Task 1).
- Produces: for a book, after inspection, `stored_path` becomes `pending/<id> <canonical filename>`; `resumeInterruptedChecks` and withdrawal use `stored_path` (never reconstruct `${id}.${ext}`); `defaultsFor` calls `parseName(<canonical filename>, type)`.
- Failure contract: if the rename or re-parse fails, `stored_path` and the card are left as they were (no partial rename), and the item still reviews.

- [ ] **Step 1: Write the failing test**

```python
check("the staged book is renamed to its canonical name",
      pending_path(upload_id).name == f"{upload_id} Mistborn #1 - The Final Empire.epub", ...)
check("the review card's defaults come from the canonical name",
      item_defaults(upload_id)["Series"] == "Mistborn" and item_defaults(upload_id)["Title"] == "The Final Empire", ...)
check("a kindle-converted book is renamed from .epub, not .mobi", P is not None and P.suffix == ".epub", ...)
check("an unparseable book is left staged and still reviews",
      pending_path(u2).exists() and item_defaults(u2) is not None, ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tests/run.sh --fast --only test_book_identification`
Expected: FAIL — the pending file is `pending/<id>.epub`.

- [ ] **Step 3: Implement the rename + re-parse**

After `setPending` and `inspectInBackground`, for book kind compute the canonical name from the guess and rename the pending file to `pending/<id> <canonical>`, update `stored_path` (new `q.setStoredPath`), then `inspectInBackground`. Change `resumeInterruptedChecks` and the delete route to trust `stored_path` (fall back to the old path if `stored_path` is null). Only rename within `PENDING_DIR`; never on failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `tests/run.sh --fast --only test_book_identification && tests/run.sh --fast --only test_uploads`
Expected: PASS; the existing upload/withdraw/resume tests still pass.

- [ ] **Step 5: Commit**

```bash
git add kavita-companion/src/uploads.ts kavita-companion/src/review.ts tests/test_book_identification.py
git commit -m "books: rename the staged file to its canonical name before review"
```

---

## Follow-on plans (separate, not in this plan)

These were decided in the same session but are independent subsystems; each gets its own plan so it ships as working software on its own:

- **Plan B — Metadata UI under the main upload div:** per-item identify/rename/Find-metadata in the upload area (`web/main.js`, `public/index.html`), reusing the existing dialog.
- **Plan C — "Grab metadata" for the current page:** a reviewer action bounded to the visible queue page, honouring rate limits/cooldowns and the M6 no-bulk rule (`review.ts` + web).
- **Plan D — Enable Open Library on live:** read live `provider_config` read-only, then set `PROVIDER_OPENLIBRARY_ENABLED=true` in live `.env` and restart; verify via `/api/metadata-sources`.

## Self-review notes

- Coverage: every decision from the session is in a task or a follow-on plan; every Review-Focus item has a test in the owning task.
- Types: `MatchQuery.series`, `guessFromFilename`, `bookMediaDefaults`, `canonicalBookName`, `proposedName`, `stored_path` are consistent across tasks.
- Deliberate limit: no new JS unit-test runner is introduced (the host has no Node); the pure helper is exercised through the acceptance surface, matching the existing suite.
