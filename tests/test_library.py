#!/usr/bin/env python3
"""Library view (phase 2, M5): the reviewer-only browse/search and "needs metadata" endpoints.

To exercise the missing-field detection against real Kavita state, this seeds one tiny series with
deliberately partial metadata (tests/library_fixture.py), checks it, then removes it again. Every
other call is read-only. No file is ever opened or written by the endpoints themselves.

Run: python3 tests/test_library.py
"""
import sys
import urllib.parse

from harness import app, check, finish, kavita, login
from library_fixture import cleanup, seed
from settings import library_ids

COMICS = library_ids()["Comics"]
quote = urllib.parse.quote
admin, uploader, readonly = login("ADMIN"), login("UPLOADER"), login("READONLY")

# --- reviewer-only ---
check("uploader cannot browse the library (403)", app("GET", "/api/library/series", uploader)[0] == 403)
check("read-only user cannot browse the library (403)", app("GET", "/api/library/series", readonly)[0] == 403)
check("a signed-out request is refused (401)", app("GET", "/api/library/series")[0] == 401)
check("uploader cannot read the needs-metadata queue (403)", app("GET", "/api/library/incomplete", uploader)[0] == 403)
check("read-only user cannot read the queue (403)", app("GET", "/api/library/incomplete", readonly)[0] == 403)
check("a signed-out queue request is refused (401)", app("GET", "/api/library/incomplete")[0] == 401)

# --- the envelope and a bad library filter never 500 ---
status, envelope = app("GET", "/api/library/series", admin)
check("browse returns the paginated envelope",
      status == 200 and {"rows", "page", "pageSize", "hasMore", "count", "cap"} <= set(envelope), f"{status} {str(envelope)[:160]}")
check("browse caps the metadata lookups it will make", envelope.get("cap") == 50, str(envelope.get("cap")))
status, empty_search = app("GET", f"/api/library/series?q={quote('zzz-no-such-series-xyz')}", admin)
check("a search with no match returns an empty page",
      status == 200 and empty_search["rows"] == [] and empty_search["hasMore"] is False, str(empty_search)[:160])
status, queue = app("GET", "/api/library/incomplete", admin)
check("the queue returns the documented envelope",
      status == 200 and {"rows", "page", "pageSize", "limit", "scanned", "cap", "hasMore"} <= set(queue), f"{status} {str(queue)[:160]}")

# --- missing-field detection against a real series ---
cleanup()  # clear anything a previous crashed run left behind
series = seed()
try:
    # Pagination boundaries: one series per page.
    status, page1 = app("GET", f"/api/library/series?libraryId={COMICS}&page=1&pageSize=1", admin)
    check("browse honours pageSize", status == 200 and len(page1["rows"]) <= 1, str(page1["rows"])[:160])
    if page1.get("hasMore"):
        _, page2 = app("GET", f"/api/library/series?libraryId={COMICS}&page=2&pageSize=1", admin)
        same = page1["rows"][0]["seriesId"] == page2["rows"][0]["seriesId"] if page2["rows"] else False
        check("a later page returns a different series", len(page2["rows"]) <= 1 and not same, f"{page1['rows']} {page2['rows']}")

    # The seeded series has Writer + Year, no Summary and no Genre.
    status, found = app("GET", f"/api/library/series?libraryId={COMICS}&q={quote(series)}&pageSize=50", admin)
    row = next((r for r in found.get("rows", []) if r["name"] == series), None)
    check("search finds the seeded series", status == 200 and row is not None, str(found.get("rows"))[:200])
    check("a browse row has the documented fields",
          row is not None and {"seriesId", "name", "libraryId", "libraryName", "releaseYear", "publicationStatus",
                               "hasSummary", "hasWriter", "hasGenre", "hasYear", "missing", "kavitaUrl", "review"} <= set(row),
          str(row)[:240])
    check("the signal matches the file's metadata",
          row is not None and row["hasWriter"] is True and row["hasYear"] is True
          and row["hasSummary"] is False and row["hasGenre"] is False, str(row)[:240])
    check("the row lists exactly the missing fields",
          row is not None and row["missing"] == ["summary", "genre"], str(row and row["missing"]))
    check("the row links to its Kavita page",
          row is not None and f"/library/{COMICS}/series/{row['seriesId']}" in row["kavitaUrl"], str(row and row["kavitaUrl"]))
    check("a series with no portal upload has no review match", row is not None and row["review"] == {}, str(row and row["review"]))

    status, queue = app("GET", f"/api/library/incomplete?libraryId={COMICS}&limit=50", admin)
    queued = next((r for r in queue.get("rows", []) if r["name"] == series), None)
    check("the queue includes the incomplete series", status == 200 and queued is not None, str(queue)[:200])
    check("the queued row says what it is missing", queued is not None and queued["missing"] == ["summary", "genre"], str(queued))
    check("every queued row is actually missing something",
          all(r["missing"] and len(r["missing"]) > 0 for r in queue.get("rows", [])))
    check("the queue reports how many series it checked", queue.get("scanned", 0) >= 1, str(queue.get("scanned")))

    # Fill the gaps in Kavita; a forced re-check (refresh=1) should now see a complete series.
    sid = row["seriesId"]
    _, meta = kavita("GET", f"/api/Series/metadata?seriesId={sid}")
    meta.pop("id", None)  # Kavita's UpdateSeriesMetadataDto wraps the full SeriesMetadataDto
    meta["summary"] = "A test summary."
    meta["genres"] = [{"id": 0, "title": "Action"}]
    status, _ = kavita("POST", "/api/Series/metadata", {"seriesMetadata": meta})
    check("Kavita accepted the metadata fill", status == 200, str(status))
    _, again = app("GET", f"/api/library/series?libraryId={COMICS}&q={quote(series)}&pageSize=50&refresh=1", admin)
    arow = next((r for r in again.get("rows", []) if r["name"] == series), None)
    check("after filling, the signal turns complete",
          arow is not None and arow["missing"] == [] and arow["hasSummary"] and arow["hasGenre"], str(arow)[:240])
    _, queue2 = app("GET", f"/api/library/incomplete?libraryId={COMICS}&limit=50&refresh=1", admin)
    check("a completed series leaves the queue",
          not any(r["name"] == series for r in queue2.get("rows", [])), str(queue2.get("rows"))[:200])
finally:
    cleanup(series)

sys.exit(finish())
