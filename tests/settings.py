"""Settings shared by the tests. Everything comes from the stack's .env, so the tests run against
whatever this checkout is configured for (see tests/README.md).

Browser tests run inside the Playwright container and pass the mounted .env path as argv[1].
"""
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _load(path: pathlib.Path) -> dict:
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


ENV_PATH = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].endswith(".env") else ROOT / ".env"
env = _load(ENV_PATH)

DOMAIN = env["DOMAIN"]
ORIGIN = f"https://{DOMAIN}:{env['COMPANION_HTTPS_PORT']}"          # the portal
COMPANION_PORT = int(env["COMPANION_HTTPS_PORT"])
KAVITA_PUBLIC = f"https://{DOMAIN}:{env['KAVITA_HTTPS_PORT']}"      # Kavita over HTTPS
KAVITA_LOCAL = f"http://{env.get('DOCKER_GATEWAY', '')}:{env.get('KAVITA_LOCAL_PORT', '')}"  # admin API, host only
MEDIA = pathlib.Path(env.get("MEDIA_ROOT", "/srv/media"))
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
