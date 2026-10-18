# Live naming: fix-in-place on /srv/media (2026-10-17)

Deployed the naming code to live (`kavita-companion:0.7.2-naming`) and ran the portal's **Fix** on every approved file still in the library, so `planApproval` re-derived the clean folder and file name and Kavita rescanned. `/srv/media` was backed up first to `/srv/kavita/backups/media-20261017-231234` (8.0G).

`0.7.2-naming` was only the interim deploy for the fix run: the work was then released as **0.8.0** and live was repinned to the published `ghcr.io/hsabort/kavita-companion:0.8.0` (see `CHANGELOG.md`).

**Why not remove + re-upload:** the portal's duplicate guard refuses bytes that match an approved upload (all of them did), and there is no "remove approved file" action — only Fix, which renames in place. A literal remove + re-upload would have needed companion-DB surgery.

**Fixed: 74 files.**

## Original (raw upload) -> renamed

| Library | Original upload name | In the library now |
|---|---|---|
| Books | `Adams, Douglas - The Ultimate Hitchhiker's Guide to the Galaxy.mobi` | `books/Douglas Adams/The ultimate hitchhiker's guide to the galaxy.epub` |
| Books | `(Dungeon Crawler Carl 1) Matt Dinniman - Dungeon Crawler Carl.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #1 - A LitRPG Gamelit Adventure.epub` |
| Books | `(Dungeon Crawler Carl 3) Matt Dinniman - The Dungeon Anarchists Cookbook.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #3 - The Dungeon Anarchist's Cookbook.epub` |
| Books | `(Dungeon Crawler Carl 4) Matt Dinniman - The Gate of the Feral Godsepub.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #4 - The Gate of the Feral Gods.epub` |
| Books | `(Dungeon Crawler Carl 5) Matt Dinniman - The Butchers Masquerade.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #5 - The Butcher's Masquerade.epub` |
| Books | `(Dungeon Crawler Carl 6) Matt Dinniman - The Eye of the Bedlam Bride.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #6 - The Eye of the Bedlam Bride.epub` |
| Books | `(Dungeon Crawler Carl 7) Matt Dinniman - This Inevitable Ruin.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #7 - This Inevitable Ruin.epub` |
| Books | `(Dungeon Crawler Carl 8) Matt Dinniman - A Parade of Horribles.epub` | `books/Dungeon Crawler Carl/Dungeon Crawler Carl #8 - A Parade of Horribles.epub` |
| Books | `Lord of the Rings 1 - Fellowship of the Rings.pdf` | `books/Lord of the Rings/Lord of the Rings.pdf` |
| Comics | `Iron Man v1 01.cbr` | `comics/Iron Man v1 (1968-1996)/Iron Man v1 01.cbz` |
| Comics | `Iron Man v1 02.cbr` | `comics/Iron Man v1 (1968-1996)/Iron Man v1 02.cbz` |
| Comics | `Iron Man v1 03.cbr` | `comics/Iron Man v1 (1968-1996)/Iron Man v1 03.cbz` |
| Comics | `Iron Man v1 04.cbr` | `comics/Iron Man v1 (1968-1996)/Iron Man v1 04.cbz` |
| Comics | `Iron Man v1 05.cbr` | `comics/Iron Man v1 (1968-1996)/Iron Man v1 05.cbz` |
| Comics | `Iron Man v1 06.cbr` | `comics/Iron Man v1 (1968-1996)/Iron Man v1 06.cbz` |
| Comics | `Saga Book 03 (2019) (Digital-Empire).cbz` | `comics/Saga/Saga #003.cbz` |
| Comics | `Saga 062 (2023) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga #062.cbz` |
| Comics | `Saga 063 (2023) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga #063.cbz` |
| Comics | `Saga 064 (2023) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga #064.cbz` |
| Comics | `Saga 065 (2023) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga #065.cbz` |
| Comics | `Saga 066 (2023) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga #066.cbz` |
| Comics | `Saga Vol. 01 (2012) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga v1 #001.cbz` |
| Comics | `Saga Book 02 (2017) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga v1 #002.cbz` |
| Comics | `Saga Vol. 02 (2013) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga v2 #002.cbz` |
| Comics | `Saga Vol. 03 (2014) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga v3 #003.cbz` |
| Comics | `Saga Vol. 04 (2014) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga v4 #004.cbz` |
| Comics | `Saga Vol. 05 (2015) (Digital) (Zone-Empire).cbr` | `comics/Saga/Saga v5 #005.cbz` |
| Comics | `Sex Criminals 026 (2020) (Digital) (Zone-Empire).cbr` | `comics/Sex Criminals/Sex Criminals 026.cbz` |
| Comics | `Sex Criminals 027 (2020) (Digital) (Zone-Empire).cbr` | `comics/Sex Criminals/Sex Criminals 027.cbz` |
| Comics | `Sex Criminals 028 (2020) (Digital) (Zone-Empire).cbr` | `comics/Sex Criminals/Sex Criminals 028.cbz` |
| Comics | `Star Wars 076 (1983) (Digital) (Zone-Empire).cbr` | `comics/Star Wars/Star Wars #076.cbz` |
| Comics | `Star Wars 077 (1983) (Digital) (Zone-Empire).cbr` | `comics/Star Wars/Star Wars #077.cbz` |
| Comics | `Star Wars 078 (1983) (Digital) (Zone-Empire).cbr` | `comics/Star Wars/Star Wars #078.cbz` |
| Comics | `The Wicked + The Divine Vol. 01 - The Faust Act (2014) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 01 - The Faust Act.cbz` |
| Comics | `The Wicked + The Divine Vol. 02 - Fandemonium (2015) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 02 - Fandemonium.cbz` |
| Comics | `The Wicked + The Divine Vol. 03 - Commercial Suicide (2016) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 03 - Commercial Suicide.cbz` |
| Comics | `The Wicked + The Divine Vol. 04 - Rising Action (2016) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 04 - Rising Action.cbz` |
| Comics | `The Wicked + The Divine Vol. 05 - Imperial Phase Part 01 (2017) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 05 - Imperial Phase Part 01.cbz` |
| Comics | `The Wicked + The Divine Vol. 06 - Imperial Phase Part 02 (2018) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 06 - Imperial Phase Part 02.cbz` |
| Comics | `The Wicked + The Divine Vol. 07 - Mothering Invention (2018) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 07 - Mothering Invention.cbz` |
| Comics | `The Wicked + The Divine Vol. 08 - Old is the New New (2019) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 08 - Old is the New New.cbz` |
| Comics | `The Wicked + The Divine Vol. 09 - 'Okay' (2019) (Digital) (Zone-Empire).cbr` | `comics/The Wicked + The Divine/The Wicked + The Divine Vol. 09 - 'Okay'.cbz` |
| Manga | `Solo Leveling 159 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c159.cbz` |
| Manga | `Solo Leveling 160 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c160.cbz` |
| Manga | `Solo Leveling 161 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c161.cbz` |
| Manga | `Solo Leveling 162 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c162.cbz` |
| Manga | `Solo Leveling 163 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c163.cbz` |
| Manga | `Solo Leveling 164 (2021) (Digital) (-KS-).cbz` | `manga/Solo Leveling/Solo Leveling c164.cbz` |
| Manga | `Solo Leveling 165 (2021) (Digital) (-KS-).cbz` | `manga/Solo Leveling/Solo Leveling c165.cbz` |
| Manga | `Solo Leveling 166 (2021) (Digital) (-KS-).cbz` | `manga/Solo Leveling/Solo Leveling c166.cbz` |
| Manga | `Solo Leveling 167 (2021) (Digital) (-KS-).cbz` | `manga/Solo Leveling/Solo Leveling c167.cbz` |
| Manga | `Solo Leveling 168 (2021) (Digital) (-KS-).cbz` | `manga/Solo Leveling/Solo Leveling c168.cbz` |
| Manga | `Solo Leveling 169 (2021) (Digital) (-KS-).cbz` | `manga/Solo Leveling/Solo Leveling c169.cbz` |
| Manga | `Solo Leveling 170 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c170.cbz` |
| Manga | `Solo Leveling 171 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c171.cbz` |
| Manga | `Solo Leveling 172 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c172.cbz` |
| Manga | `Solo Leveling 173 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c173.cbz` |
| Manga | `Solo Leveling 174 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c174.cbz` |
| Manga | `Solo Leveling 175 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c175.cbz` |
| Manga | `Solo Leveling 176 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c176.cbz` |
| Manga | `Solo Leveling 177 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c177.cbz` |
| Manga | `Solo Leveling 178 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c178.cbz` |
| Manga | `Solo Leveling 179 (2022) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling c179.cbz` |
| Manga | `Solo Leveling v01 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v01.cbz` |
| Manga | `Solo Leveling v02 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v02.cbz` |
| Manga | `Solo Leveling v03 (2021) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v03.cbz` |
| Manga | `Solo Leveling v04 (2022) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v04.cbz` |
| Manga | `Solo Leveling v05 (2022) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v05.cbz` |
| Manga | `Solo Leveling v06 (2023) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v06.cbz` |
| Manga | `Solo Leveling v07 (2023) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v07.cbz` |
| Manga | `Solo Leveling v08 (2024) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v08.cbz` |
| Manga | `Solo Leveling v09 (2024) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v09.cbz` |
| Manga | `Solo Leveling v10 (2024) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v10.cbz` |
| Manga | `Solo Leveling v11 (2025) (Digital) (LuCaZ).cbz` | `manga/Solo Leveling/Solo Leveling v11.cbz` |

## On-disk files with no approved row (1)

- `books/Kavita Test Book/Kavita Test Book.epub`

## Kavita after the rescan

- **Books** (4): `Dungeon Crawler Carl`, `Kavita Test Book`, `TOLKIEN J.R.R - Lord of the Rin`, `The ultimate hitchhiker's guide to the galaxy`
- **Comics** (6): `Iron Man v1`, `Saga`, `Saga Book`, `Sex Criminals`, `Star Wars`, `The Wicked + The Divine`
- **Manga** (1): `Solo Leveling`

## Findings

- **Standalone books.** The Fix form seeded a book's Series from the folder (the author for a standalone), so re-saving one produced `<Author> - <Title>` (Douglas Adams) or a spurious number (`Lord of the Rings #1.pdf`). Fixed in code (`6d16ca9`); both files corrected in place.
- **`books/Kavita Test Book/Kavita Test Book.epub`** has no approved row, so Fix cannot touch it.
- **`Lord of the Rings.pdf`**: Kavita shows the series from the PDF's *internal* metadata (`TOLKIEN J.R.R - Lord of the Rin`). The companion only renames the file, so the folder is clean but Kavita's series name is not — a separate (content) issue.
- A live user (`jp-kavita2`) approved ~9 more files during the run; they came out clean from the new code (e.g. `Saga v6 #006.cbz`, `Saga #007.cbz`).

## Follow-up (2026-10-18): live cleanup

Tied up the leftovers from the fix-in-place run. `/srv/media` and `companion.db` were backed up
again first (`backups/media-20261018-004940`, `backups/companion.db.20261018-004940`).

- **Test artifact removed.** `books/Kavita Test Book/Kavita Test Book.epub` (embedded author
  `Setup Check`, no approved row) and its Kavita series were deleted.
- **Dangling rows purged.** 84 `approved` rows left by test-suite runs on 2026-10-15
  (`Kc Test Series`, `Browser Review`, `Kc5 Pdf`, `Kc5 Series`, `Kc5 Books`, `Kc6 After`,
  `Kavita Test Book - Extra`, `Renamed.epub`) pointed at files that no longer existed yet still
  counted as approved and fed the duplicate guard. Deleted (208 approved -> 124).
- **LOTR embedded metadata fixed.** The three `Lord of the Rings/*.pdf` scans carried the scanner's
  `/Title` (`TOLKIEN J.R.R - Lord of the Rin`) and `/Author` (`G. Mills`) — and Kavita uses that
  `/Title` as the book *series* name. All three were rewritten in place (`/Info` + XMP) to
  `Title = Lord of the Rings`, `Author = J.R.R. Tolkien`, and the stored `final_sha256` refreshed.
  Kavita now shows one clean `Lord of the Rings` series (3 books, 262/211/181 pages).

Live library after cleanup: **Books** 8, **Comics** 7, **Manga** 1; portal 124 approved / 0 dangling.
