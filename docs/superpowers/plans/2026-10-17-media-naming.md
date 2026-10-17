# Media naming cleanup — Implementation Plan

**Goal:** Every approved file gets a clean, Kavita-friendly name: no release/scene tags, no bare
years, no orphan brackets, no repeated series prefix in a book title, and a consistent per-type shape.

**Why:** The 158 files already in the live library keep scene tags (`(2020) (Digital) (Zone-Empire)`,
`(LuCaZ)`, `(-KS-)`), a lone parenthesis (`(Dungeon Crawler Carl/`), a year range in a folder
(`Iron Man v1 (1968-1996)`), and long book titles that repeat the series and carry a series blurb
(`The Gate of the Feral Gods: Dungeon Crawler Carl Book 4`). Kavita can still find most of these, but
the names are ugly and the round-trip re-upload is the moment to fix them.

**Architecture:** One pure helper, `cleanName()` (`src/naming.ts`), strips noise from any name
segment. It is applied at the two places a name becomes a path: the review card's defaults and the
approval plan (`planApproval`). Book titles get one extra rule, `cleanBookTitle()`, that drops a
repeated series prefix and a trailing series blurb. The portal mirrors both helpers so the
destination preview matches what the server will write; the server stays authoritative (it cleans
again), so a divergence can only change the suggestion, never the saved name.

**Deliberate limits:**
- The comic/manga filename shape is unchanged (`<Series> [v<NN>] [#<NNN>]` / manga `c<NNN>`); only
  the comic volume is now zero-padded to two digits and the series/title are cleaned. Kavita's parser
  is inconsistent about trade-vs-issue (it gives `Vol. 01` both a volume and a number, and reads a
  bare `v1` as a volume), so forcing a trade/issue distinction would misfile real issues. The
  reviewer still sets Volume/Number.
- Cleaning never touches a legitimate bracketed subtitle (`(The Faust Act)`): only bare years, known
  release words, and "shouty" scanner groups (a digit, a separator, an acronym run, or internal
  capitals) are dropped.

## Global constraints
- Work in `/srv/kavita-test` (`develop`); the live stack is untouched until an explicit deploy.
- Fast tier (`tests/run.sh --fast`) stays write-free; the approval test goes in the slow tier.
- Kavita `LibraryType`: Manga=0, Comic=5, Book=2, LightNovel=4.
- `safeSegment()` still runs last (filesystem safety is not weakened); `cleanName()` runs first.

---

### Task 1: `cleanName()` + `cleanBookTitle()` (pure helpers)

**Files:** Create `kavita-companion/src/naming.ts`; test `tests/test_naming.py` (new, fast tier).

- [x] Step 1: Write `tests/test_naming.py` — upload CBZs/EPUBs whose embedded metadata is dirty and
  read `/api/review` defaults (no library writes):
  - Comic CBZ, ComicInfo `Series=(Saga (1968-1996)`, `Title=Saga 001 (2020) (Digital) (Zone-Empire)`
    → `defaults.Series == "Saga"`.
  - Manga CBZ, ComicInfo `Series=Solo Leveling (2021) (Digital) (LuCaZ)` → `"Solo Leveling"`.
  - EPUB dc:title `The Gate of the Feral Gods: Dungeon Crawler Carl Book 4`, calibre:series
    `Dungeon Crawler Carl`, index 4 → Title `The Gate of the Feral Gods`, stagedName
    `Dungeon Crawler Carl #4 - The Gate of the Feral Gods.epub`.
  - EPUB dc:title `Dungeon Crawler Carl: A LitRPG/Gamelit Adventure`, same series, index 1 → Title
    `A LitRPG/Gamelit Adventure`.
  - EPUB dc:title `The Ultimate Hitchhiker's Guide to the Galaxy (2005)`, calibre:series
    `(Dungeon Crawler Carl`, index 2 → Series `Dungeon Crawler Carl`, Title
    `The Ultimate Hitchhiker's Guide to the Galaxy`.
  - EPUB dc:title `Dune: Messiah`, no series → Title stays `Dune: Messiah` (standalone titles with a
    colon are not shredded).
- [x] Step 2: Run `tests/run.sh --fast --only test_naming`; expect FAIL (tags/orphans retained).
- [x] Step 3: Implement `cleanName()` and `cleanBookTitle()` in `src/naming.ts`.
- [x] Step 4: Run again; expect PASS.

### Task 2: Wire cleaning into identification and approval

**Files:** `src/identify.ts` (`bookMediaDefaults`, `canonicalBookName`), `src/review.ts`
(`defaultsFor`, `planApproval`); tests as above plus the slow approval test.

- [x] Step 1: Extend `tests/test_review.py` (slow): approve a comic with a dirty typed series
  `"(Kc Name <tag>"` and a dirty file name `"Kc Name <tag> 001 (2020) (Digital) (Zone-Empire).cbr"`
  → destination `/data/comics/Kc Name <tag>/Kc Name <tag> 001.cbz`.
- [x] Step 2: Run `tests/run.sh --slow --only test_review`; expect FAIL.
- [x] Step 3: `bookMediaDefaults` cleans `Series` (and `Title` via `cleanBookTitle`); `canonicalBookName`
  cleans every segment; `defaultsFor` cleans the comic/manga series; `planApproval` runs `cleanName`
  over the typed series and file base before `safeSegment`.
- [x] Step 4: Run `--only test_review`; expect PASS; then the fast tier.

### Task 2b: Round-trip traps found by the rehearsal

The first rehearsal re-uploaded live files and exposed two defects, now fixed and tested:
- A standalone book's own file came back as a series because approval wrote its author as
  `calibre:series`. Now a standalone book carries no `calibre:series`, and an embedded series that
  merely repeats the author is ignored.
- `Iron Man v1 01.cbr` under the series `Iron Man v1` produced `Iron Man v1 v01 #001.cbz`; a volume
  already named by the series is no longer repeated (`dedupeSeriesVolume`).

### Task 3: Mirror the helpers in the portal

**Files:** `kavita-companion/web/main.js` (`templateName` and a JS `cleanName`/`cleanBookTitle`).

- [x] Step 1: Pad the comic volume to two digits and clean series/title in `templateName`, so the
  destination preview matches the server. Verify with `tests/run.sh --browser --only review_page`.

### Task 4: Full regression + CHANGELOG

- [x] Step 1: `tests/run.sh --fast` and `tests/run.sh --slow`; both green (27 files, all pass).
- [x] Step 2: `tests/run.sh --browser --only review_page`; green.
- [x] Step 3: CHANGELOG `## Unreleased` entry; commit (`1a5c6a9`, `8089dcb`).

## Rehearsal (test stack)

The full live library (75 files) was re-uploaded through the test portal and verified. The complete
original → renamed table and the findings are in
[`2026-10-17-media-naming-rehearsal.md`](2026-10-17-media-naming-rehearsal.md). Result: 75/75
approved, written and indexed; no refusals or collisions. One defect surfaced and was fixed: a `Vol.`
trade no longer suggests an issue number read out of a subtitle ("… Part 01").

## Follow-on (separate): the live round-trip
The rehearsal passed. The live round-trip (remove → re-upload → revalidate) still needs an explicit
go-ahead, a `/srv/media` backup, and a content-preservation check.

