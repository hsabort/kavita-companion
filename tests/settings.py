"""Settings shared by the tests. Everything comes from the stack's .env, so the tests run against
whatever this checkout is configured for (see tests/README.md).

Browser tests run inside the Playwright container and pass the mounted .env path as argv[1].
"""
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The live stack's library. Tests must never resolve their media root to this (see the guard below).
LIVE_MEDIA = pathlib.Path("/srv/media")


def _load(path: pathlib.Path) -> dict:
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


ENV_PATH = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].endswith(".env") else ROOT / ".env"
env = _load(ENV_PATH)

# --- Safety: never run against the live stack -----------------------------------------------------
# These tests upload into, rename and delete files under the media root and edit Kavita series, and
# run.sh restarts the portal. Point them at the live library by accident (e.g. running tests/run.sh
# from the live checkout, whose .env carries the TEST_* accounts) and they will damage it. Two locks,
# both must hold. settings.py is imported by every test and by run.sh's preflight, so the run stops
# before anything is touched. A live .env sets neither, so a marker cannot leak in from there.
if env.get("TEST_STACK") != "1":
    raise SystemExit(f"refusing to run the tests: {ENV_PATH} does not set TEST_STACK=1, so it is not a test stack")
if pathlib.Path(env.get("MEDIA_ROOT", str(LIVE_MEDIA))) == LIVE_MEDIA:
    raise SystemExit(f"refusing to run the tests: {ENV_PATH} points MEDIA_ROOT at the live library ({LIVE_MEDIA})")

DOMAIN = env["DOMAIN"]
ORIGIN = f"https://{DOMAIN}:{env['COMPANION_HTTPS_PORT']}"          # the portal
COMPANION_PORT = int(env["COMPANION_HTTPS_PORT"])
KAVITA_PUBLIC = f"https://{DOMAIN}:{env['KAVITA_HTTPS_PORT']}"      # Kavita over HTTPS
KAVITA_LOCAL = f"http://{env.get('DOCKER_GATEWAY', '')}:{env.get('KAVITA_LOCAL_PORT', '')}"  # admin API, host only
MEDIA = pathlib.Path(env.get("MEDIA_ROOT", str(LIVE_MEDIA)))
INCOMING = MEDIA / ".incoming"
_data_root = pathlib.Path(env.get("DATA_ROOT", "./data"))
DATA = _data_root if _data_root.is_absolute() else (ROOT / _data_root).resolve()
COMPANION_DB = DATA / "companion" / "companion.db"


def library_ids() -> dict:
    """Kavita library ids by name, e.g. {"Comics": 2, "Books": 3}."""
    req = urllib.request.Request(f"{KAVITA_LOCAL}/api/Library/libraries",
                                 headers={"x-api-key": env["COMPANION_KAVITA_AUTH_KEY"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        return {lib["name"]: lib["id"] for lib in json.load(r)}
