#!/usr/bin/env python3
"""The suite must refuse to run against anything but a test stack.

tests/settings.py is imported by every test. If it resolved MEDIA_ROOT to the live library
(/srv/media), the suite would upload into, rename and delete real files, and drive the live stack.
These checks import settings.py in a subprocess against crafted .env files and assert it refuses a
live-looking environment while accepting a properly marked test one.

Run: python3 tests/test_settings_guard.py
"""
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from harness import check, finish  # noqa: E402  (after the sys.path fix above)

TESTS = pathlib.Path(__file__).resolve().parent
BASE = {
    "DOMAIN": "example.test",
    "COMPANION_HTTPS_PORT": "20006",
    "KAVITA_HTTPS_PORT": "20007",
    "KAVITA_LOCAL_PORT": "20002",
    "DOCKER_GATEWAY": "172.31.0.1",
    "DATA_ROOT": "./data-test",
}


def run_settings(**overrides):
    """Import settings.py in a subprocess with a crafted .env; return (returncode, output)."""
    values = {**BASE, **overrides}
    with tempfile.TemporaryDirectory() as tmp:
        env_path = pathlib.Path(tmp) / ".env"
        env_path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        proc = subprocess.run([sys.executable, "-c", "import settings", str(env_path)],
                              cwd=TESTS, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def main():
    code, out = run_settings(TEST_STACK="1", MEDIA_ROOT="/srv/media")
    check("refuses the live media root even when marked TEST_STACK", code != 0 and "live" in out.lower(), out.strip())

    code, out = run_settings(MEDIA_ROOT="/srv/media-test")
    check("refuses an .env with no TEST_STACK marker", code != 0 and "TEST_STACK" in out, out.strip())

    code, out = run_settings(TEST_STACK="1", MEDIA_ROOT="/tmp/some-media-test")
    check("accepts a marked test stack with its own media root", code == 0, out.strip())

    sys.exit(finish())


if __name__ == "__main__":
    main()
