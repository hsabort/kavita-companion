"""The exact text the app shows when a format needs a capability this image lacks.

`capabilities.ts` builds it from the format set, the wording and the running version; the tests pin
that text so a wording change fails them (Task 8 tightens Task 3's `"-formats" in error`). It is kept
free of `settings` on purpose: the CI `--image-only` run of `test_default_image.py` has no stack and
no `.env`, so importing `settings` (or `harness`, which imports it) would abort before any assertion.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "ghcr.io/hsabort/kavita-companion"

# The extensions each capability covers, as capabilities.ts names them.
FORMATS = {
    "archive-extras": "`.cbr`, `.cb7`, `.rar`, `.7z`",
    "kindle": "`.mobi`, `.azw`, `.azw3`",
}


def capability_message(capability: str) -> str:
    """`capabilityMessage(capability)` from kavita-companion/src/capabilities.ts."""
    version = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]
    # A released build names its own `-formats` tag; a development build points at the generic image.
    target = (f"`{IMAGE}:{version}-formats`" if re.fullmatch(r"\d+\.\d+\.\d+", version)
              else "the `-formats` image for this release")
    return (f"{FORMATS[capability]} files need the optional formats image, which adds 7-Zip and "
            f"KindleUnpack. Run {target} instead (see docs/operations.md).")
