#!/usr/bin/env python3
"""A tiny, self-cleaning Kavita series for the Library-view tests (phase 2, M5).

The Library-view endpoints read Kavita's own catalogue, so testing "which metadata is missing" needs
a real series. Creating one through the portal's full upload flow is slow, so this writes a one-file
CBZ with deliberately partial ComicInfo (Writer and Year, no Summary and no Genre) straight into the
test comics library, asks Kavita to scan that folder, and can remove both again. It is only ever used
against the isolated test stack (tests/README.md).

    from library_fixture import seed, cleanup
    name = seed()      # creates the series and waits until Kavita lists it
    ...
    cleanup(name)      # removes the series from Kavita and its folder

Also usable from the shell: `python3 tests/library_fixture.py seed` prints the name;
`python3 tests/library_fixture.py cleanup [name]` removes the series (all "Library Test *" if no
name is given).
"""
import io
import os
import secrets
import shutil
import sys
import time
import zipfile

from harness import kavita
from settings import MEDIA, env, library_ids

PREFIX = "Library Test"


def _comics_library() -> int:
    return library_ids()["Comics"]


def _series_id(name: str, library: int) -> int | None:
    status, listing = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                             {"statements": [{"comparison": 0, "field": 19, "value": str(library)}], "combination": 1})
    return next((s["id"] for s in (listing or []) if s["name"] == name), None)


def seed(name: str | None = None, timeout: int = 120) -> str:
    """Write one partially-described series into the test comics library and wait for Kavita."""
    library = _comics_library()
    name = name or f"{PREFIX} {secrets.token_hex(3)}"
    folder = MEDIA / "comics" / name
    folder.mkdir(parents=True, exist_ok=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(8_000))
        # Writer and Year are present; Summary and Genre are deliberately absent.
        archive.writestr("ComicInfo.xml",
                         f"<ComicInfo><Series>{name}</Series><Number>1</Number>"
                         f"<Writer>Fixture Writer</Writer><Year>2021</Year></ComicInfo>")
    (folder / f"{name} 001.cbz").write_bytes(buf.getvalue())

    kavita("POST", "/api/Library/scan-folder",
           {"apiKey": env["COMPANION_KAVITA_AUTH_KEY"], "folderPath": f"/data/comics/{name}", "abortOnNoSeriesMatch": False})
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _series_id(name, library):
            return name
        time.sleep(3)
    return name


def cleanup(name: str | None = None) -> None:
    """Remove the fixture series from Kavita and delete its folder."""
    library = _comics_library()
    status, listing = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                             {"statements": [{"comparison": 0, "field": 19, "value": str(library)}], "combination": 1})
    for series in (listing or []):
        if series["name"] == name or (name is None and series["name"].startswith(PREFIX)):
            kavita("DELETE", f"/api/Series/{series['id']}")
    for entry in os.listdir(MEDIA / "comics"):
        if entry == name or (name is None and entry.startswith(PREFIX)):
            shutil.rmtree(MEDIA / "comics" / entry, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "seed":
        print(seed())
    elif len(sys.argv) >= 2 and sys.argv[1] == "cleanup":
        cleanup(sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        sys.exit(__doc__)
