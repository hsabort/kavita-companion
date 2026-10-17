# Media naming — test-stack round-trip rehearsal (2026-10-17)

Every file in the live library was copied read-only, re-uploaded through the **test** portal
(test-uploader), approved (test-admin), checked on disk and in Kavita, then removed. `/srv/media`
was never modified. Driver: `/tmp/opencode/roundtrip/full_rehearsal.py` (throwaway).

## Result

- **75 files** (the live library really holds 75; the companion DB's 158 approved rows include 84
  stale paths from earlier fixes). **75 approved, 75 written, all indexed by Kavita.**
- No refusals, no errors, no name collisions.

## Original → renamed

| Library | Original (current live name) | Renamed by the tool |
|---|---|---|
| Books | `(Dungeon Crawler Carl 01 - Dungeon Crawler Carl A LitRPG Gamelit Adventure.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #1 - A LitRPG Gamelit Adventure.epub` |
| Books | `(Dungeon Crawler Carl 03 - The Dungeon Anarchist's Cookbook Dungeon Crawler Carl Book 3.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #3 - The Dungeon Anarchist's Cookbook.epub` |
| Books | `(Dungeon Crawler Carl 04 - The Gate of the Feral Gods Dungeon Crawler Carl Book 4.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #4 - The Gate of the Feral Gods.epub` |
| Books | `(Dungeon Crawler Carl 05 - The Butcher's Masquerade Dungeon Crawler Carl Book 5.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #5 - The Butcher's Masquerade.epub` |
| Books | `(Dungeon Crawler Carl 06 - The Eye of the Bedlam Bride Dungeon Crawler Carl Book 6.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #6 - The Eye of the Bedlam Bride.epub` |
| Books | `(Dungeon Crawler Carl 07 - This Inevitable Ruin Dungeon Crawler Carl Book 7.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #7 - This Inevitable Ruin.epub` |
| Books | `(Dungeon Crawler Carl 08 - A Parade of Horribles Dungeon Crawler Carl Book 8.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #8 - A Parade of Horribles.epub` |
| Books | `The ultimate hitchhiker's guide to the galaxy.epub` | `books/Douglas Adams/The ultimate hitchhiker's guide to the galaxy.epub` |
| Books | `Kavita Test Book.epub` | `books/Setup Check/Kavita Test Book.epub` |
| Books | `Lord of the Rings.pdf` | `books/Lord of the Rings/Lord of the Rings.pdf` |
| Comics | `Iron Man v1 01.cbr` | `comics/Iron Man v1/Iron Man v1 #001.cbz` |
| Comics | `Iron Man v1 02.cbz` | `comics/Iron Man v1/Iron Man v1 #002.cbz` |
| Comics | `Iron Man v1 03.cbz` | `comics/Iron Man v1/Iron Man v1 #003.cbz` |
| Comics | `Iron Man v1 04.cbz` | `comics/Iron Man v1/Iron Man v1 #004.cbz` |
| Comics | `Iron Man v1 05.cbz` | `comics/Iron Man v1/Iron Man v1 #005.cbz` |
| Comics | `Iron Man v1 06.cbz` | `comics/Iron Man v1/Iron Man v1 #006.cbz` |
| Comics | `Saga #003.cbz` | `comics/Saga/Saga #003.cbz` |
| Comics | `Saga #062.cbz` | `comics/Saga/Saga #062.cbz` |
| Comics | `Saga #063.cbz` | `comics/Saga/Saga #063.cbz` |
| Comics | `Saga #064.cbz` | `comics/Saga/Saga #064.cbz` |
| Comics | `Saga #065.cbz` | `comics/Saga/Saga #065.cbz` |
| Comics | `Saga #066.cbz` | `comics/Saga/Saga #066.cbz` |
| Comics | `Saga v1 #001.cbz` | `comics/Saga/Saga v01 #001.cbz` |
| Comics | `Saga v1 #002.cbz` | `comics/Saga/Saga v01 #002.cbz` |
| Comics | `Saga v2 #002.cbz` | `comics/Saga/Saga v02 #002.cbz` |
| Comics | `Saga v3 #003.cbz` | `comics/Saga/Saga v03 #003.cbz` |
| Comics | `Saga v4 #004.cbz` | `comics/Saga/Saga v04 #004.cbz` |
| Comics | `Saga v5 #005.cbz` | `comics/Saga/Saga v05 #005.cbz` |
| Comics | `Sex Criminals 026 (2020) (Digital) (Zone-Empire).cbr` | `comics/Sex Criminals/Sex Criminals #026.cbz` |
| Comics | `Sex Criminals 027 (2020) (Digital) (Zone-Empire).cbr` | `comics/Sex Criminals/Sex Criminals #027.cbz` |
| Comics | `Sex Criminals 028 (2020) (Digital) (Zone-Empire).cbr` | `comics/Sex Criminals/Sex Criminals #028.cbz` |
| Comics | `Star Wars #076.cbz` | `comics/Star Wars/Star Wars #076.cbz` |
| Comics | `Star Wars #077.cbz` | `comics/Star Wars/Star Wars #077.cbz` |
| Comics | `Star Wars #078.cbz` | `comics/Star Wars/Star Wars #078.cbz` |
| Comics | `The Wicked + The Divine Vol. 01 - The Faust Act (2014) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v01.cbz` |
| Comics | `The Wicked + The Divine Vol. 02 - Fandemonium (2015) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v02.cbz` |
| Comics | `The Wicked + The Divine Vol. 03 - Commercial Suicide (2016) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v03.cbz` |
| Comics | `The Wicked + The Divine Vol. 04 - Rising Action (2016) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v04.cbz` |
| Comics | `The Wicked + The Divine Vol. 05 - Imperial Phase Part 01 (2017) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v05.cbz` |
| Comics | `The Wicked + The Divine Vol. 06 - Imperial Phase Part 02 (2018) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v06.cbz` |
| Comics | `The Wicked + The Divine Vol. 07 - Mothering Invention (2018) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v07.cbz` |
| Comics | `The Wicked + The Divine Vol. 08 - Old is the New New (2019) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v08.cbz` |
| Comics | `The Wicked + The Divine Vol. 09 - 'Okay' (2019) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine v09.cbz` |
| Manga | `Solo Leveling c159.cbz` | `manga/Solo Leveling/Solo Leveling c159.cbz` |
| Manga | `Solo Leveling c160.cbz` | `manga/Solo Leveling/Solo Leveling c160.cbz` |
| Manga | `Solo Leveling c161.cbz` | `manga/Solo Leveling/Solo Leveling c161.cbz` |
| Manga | `Solo Leveling c162.cbz` | `manga/Solo Leveling/Solo Leveling c162.cbz` |
| Manga | `Solo Leveling c163.cbz` | `manga/Solo Leveling/Solo Leveling c163.cbz` |
| Manga | `Solo Leveling c164.cbz` | `manga/Solo Leveling/Solo Leveling c164.cbz` |
| Manga | `Solo Leveling c165.cbz` | `manga/Solo Leveling/Solo Leveling c165.cbz` |
| Manga | `Solo Leveling c166.cbz` | `manga/Solo Leveling/Solo Leveling c166.cbz` |
| Manga | `Solo Leveling c167.cbz` | `manga/Solo Leveling/Solo Leveling c167.cbz` |
| Manga | `Solo Leveling c168.cbz` | `manga/Solo Leveling/Solo Leveling c168.cbz` |
| Manga | `Solo Leveling c169.cbz` | `manga/Solo Leveling/Solo Leveling c169.cbz` |
| Manga | `Solo Leveling c170.cbz` | `manga/Solo Leveling/Solo Leveling c170.cbz` |
| Manga | `Solo Leveling c171.cbz` | `manga/Solo Leveling/Solo Leveling c171.cbz` |
| Manga | `Solo Leveling c172.cbz` | `manga/Solo Leveling/Solo Leveling c172.cbz` |
| Manga | `Solo Leveling c173.cbz` | `manga/Solo Leveling/Solo Leveling c173.cbz` |
| Manga | `Solo Leveling c174.cbz` | `manga/Solo Leveling/Solo Leveling c174.cbz` |
| Manga | `Solo Leveling c175.cbz` | `manga/Solo Leveling/Solo Leveling c175.cbz` |
| Manga | `Solo Leveling c176.cbz` | `manga/Solo Leveling/Solo Leveling c176.cbz` |
| Manga | `Solo Leveling c177.cbz` | `manga/Solo Leveling/Solo Leveling c177.cbz` |
| Manga | `Solo Leveling c178.cbz` | `manga/Solo Leveling/Solo Leveling c178.cbz` |
| Manga | `Solo Leveling c179.cbz` | `manga/Solo Leveling/Solo Leveling c179.cbz` |
| Manga | `Solo Leveling v01.cbz` | `manga/Solo Leveling/Solo Leveling v01.cbz` |
| Manga | `Solo Leveling v02.cbz` | `manga/Solo Leveling/Solo Leveling v02.cbz` |
| Manga | `Solo Leveling v03.cbz` | `manga/Solo Leveling/Solo Leveling v03.cbz` |
| Manga | `Solo Leveling v04.cbz` | `manga/Solo Leveling/Solo Leveling v04.cbz` |
| Manga | `Solo Leveling v05.cbz` | `manga/Solo Leveling/Solo Leveling v05.cbz` |
| Manga | `Solo Leveling v06.cbz` | `manga/Solo Leveling/Solo Leveling v06.cbz` |
| Manga | `Solo Leveling v07.cbz` | `manga/Solo Leveling/Solo Leveling v07.cbz` |
| Manga | `Solo Leveling v08.cbz` | `manga/Solo Leveling/Solo Leveling v08.cbz` |
| Manga | `Solo Leveling v09.cbz` | `manga/Solo Leveling/Solo Leveling v09.cbz` |
| Manga | `Solo Leveling v10.cbz` | `manga/Solo Leveling/Solo Leveling v10.cbz` |
| Manga | `Solo Leveling v11.cbz` | `manga/Solo Leveling/Solo Leveling v11.cbz` |

## Findings

- **Cleaned as intended:** the orphan bracket (`(Dungeon Crawler Carl` → `Dungeon Crawler Carl`), the
  folder year range (`Iron Man v1 (1968-1996)` → `Iron Man v1`), the scene tags on Sex Criminals and
  the Wicked trades, and the repeated series prefix / series blurb in the DCC titles.
- **Fixed during the rehearsal:** Wicked vols 5 and 6 first came out as `v05 #001` / `v06 #002` — Kavita
  read an issue number out of the subtitle ("… Part 01"). A `Vol.` trade now suggests no issue number.
- **Volume padding:** `Saga v1 #001` → `Saga v01 #001` etc.
- **Saga's structure is a data issue, not a naming one.** `Saga #003.cbz` (779 MB, an issue-shaped name
  for a trade-sized file) and `Saga v3 #003.cbz` coexist; Kavita's parser is inconsistent about
  trade-vs-issue (it gives `Vol. 01` both a volume and a number, and reads a bare `v1` as a volume), so
  the tool keeps the reviewer's Volume/Number rather than guessing. The reviewer decides.
- **Kavita's Books series name can differ from the file name.** For a standalone EPUB Kavita uses the
  title, and for a PDF it uses the PDF's *internal* metadata (`Lord of the Rings.pdf` shows as
  `TOLKIEN J.R.R - Lord of the Rin`). Both match how live already behaves.
- **`Kavita Test Book.epub` is a test artifact** left in the live library; its embedded author is
  "Setup Check", so it files under `Setup Check/`.
- **Content preservation** is covered by the test suite (`test_review`, `test_metadata`), not re-checked
  here — this rehearsal is about naming.

## Not done here
The live round-trip (remove → re-upload → revalidate on `/srv/media`) still needs an explicit go-ahead,
a `/srv/media` backup, and a content-preservation check.
