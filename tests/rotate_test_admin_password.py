#!/usr/bin/env python3
"""Give the Kavita user test-admin a new random password and store it in ../.env.

Uses the companion-svc auth key (COMPANION_KAVITA_AUTH_KEY) to reset the password,
checks that the new password logs in and the old one no longer does, then updates
TEST_ADMIN_PASSWORD in .env. The password is never printed.

Run: python3 tests/rotate_test_admin_password.py
"""
import json
import pathlib
import re
import secrets
import string
import sys
import urllib.error
import urllib.request

from settings import ENV_PATH as ENV, KAVITA_LOCAL as BASE


def post(path, body, headers=None):
    req = urllib.request.Request(
        BASE + path,
        json.dumps(body).encode(),
        {"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def main():
    env_text = ENV.read_text()
    key = re.search(r"(?m)^COMPANION_KAVITA_AUTH_KEY=(.*)$", env_text).group(1).strip()
    old = re.search(r"(?m)^TEST_ADMIN_PASSWORD=(.*)$", env_text).group(1).strip().strip("'\"")

    alphabet = string.ascii_letters + string.digits
    # 28 random chars plus a fixed tail so Kavita's upper/lower/digit/symbol rules are always met
    new = "".join(secrets.choice(alphabet) for _ in range(28)) + "!7aZ"

    status, msg = post("/api/Account/reset-password", {"userName": "test-admin", "password": new},
                       {"x-api-key": key})
    if status != 200:
        sys.exit(f"Password reset failed: HTTP {status} {msg}")

    if post("/api/Account/login", {"username": "test-admin", "password": new})[0] != 200:
        sys.exit("Reset reported success but the new password does not log in; .env left unchanged.")
    old_still_works = post("/api/Account/login", {"username": "test-admin", "password": old})[0] == 200

    ENV.write_text(re.sub(r"(?m)^TEST_ADMIN_PASSWORD=.*$", f"TEST_ADMIN_PASSWORD='{new}'", env_text))
    print("test-admin password changed and saved to .env (not shown).")
    print("Old password rejected: " + ("NO - check Kavita" if old_still_works else "yes"))


if __name__ == "__main__":
    main()
