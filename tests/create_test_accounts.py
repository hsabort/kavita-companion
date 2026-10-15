#!/usr/bin/env python3
"""Create the three Kavita test accounts in the stack described by ../.env and save their generated
passwords in .env. Idempotent: existing accounts are left alone (their passwords are never changed).

Kavita has no admin "create user" call, so this uses the invite + confirm-email flow with the
companion-svc auth key. Run from the checkout whose .env describes the stack — use the test worktree
(docs/development.md), never live:

    python3 tests/create_test_accounts.py

Passwords are never printed.
"""
import json
import re
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request

from settings import ENV_PATH as ENV, KAVITA_LOCAL as BASE

# Roles match the live test accounts (tests/README.md): uploader has the default roles, readonly adds
# Read Only and admin adds Admin. Usernames are the generic "test-*" names the docs use.
ACCOUNTS = {
    "UPLOADER": {"username": "test-uploader", "email": "test-uploader@kavita.local",
                 "roles": ["Login", "Pleb", "Download", "Bookmark", "Change Restriction", "Promote"]},
    "READONLY": {"username": "test-readonly", "email": "test-readonly@kavita.local",
                 "roles": ["Login", "Read Only"]},
    "ADMIN": {"username": "test-admin", "email": "test-admin@kavita.local",
              "roles": ["Login", "Admin"]},
}


def env_value(key: str) -> str:
    match = re.search(rf"(?m)^{key}=(.*)$", ENV.read_text())
    return match.group(1).strip().strip("'\"") if match else ""


def call(method, path, body=None, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["x-api-key"] = key
    request = urllib.request.Request(
        BASE + path, json.dumps(body).encode() if body is not None else None, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()[:200]


def password() -> str:
    # 24 random characters plus a fixed tail so Kavita's upper/lower/digit/symbol rules are always met.
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(24)) + "!7aZ"


def set_env(text: str, key: str, value: str) -> str:
    if re.search(rf"(?m)^{key}=.*$", text):
        return re.sub(rf"(?m)^{key}=.*$", f"{key}='{value}'", text)
    return text + f"{key}='{value}'\n"


def main():
    key = env_value("COMPANION_KAVITA_AUTH_KEY")
    if not key:
        sys.exit("COMPANION_KAVITA_AUTH_KEY is empty in .env; run ./setup.sh first.")
    status, libraries = call("GET", "/api/Library/libraries", key=key)
    if status != 200:
        sys.exit(f"Could not read libraries (HTTP {status}): {libraries}")
    library_ids = [library["id"] for library in libraries]

    status, users = call("GET", "/api/Users", key=key)
    existing = {user["username"]: user["id"] for user in users} if status == 200 else set()

    text = ENV.read_text()
    for label, spec in ACCOUNTS.items():
        username = spec["username"]
        created = username not in existing
        if created:
            # Kavita gives every new account its default roles, so the invite asks for none (asking for
            # a default role fails with "UserAlreadyInRole"); the exact roles are set just below.
            invite = {"email": spec["email"], "roles": [], "libraries": library_ids,
                      "ageRestriction": {"ageRating": 0, "includeUnknowns": False}}
            status, body = call("POST", "/api/Account/invite", invite, key=key)
            if status != 200:
                sys.exit(f"Inviting {username} failed (HTTP {status}): {body}")
            query = urllib.parse.parse_qs(urllib.parse.urlparse(body["emailLink"]).query)
            confirm = {"email": query["email"][0], "token": query["token"][0],
                       "username": username, "password": password()}
            status, body = call("POST", "/api/Account/confirm-email", confirm)
            if status != 200:
                sys.exit(f"Confirming {username} failed (HTTP {status}): {body}")
        # update replaces the role set, so the exact roles never clash with the defaults.
        status, users = call("GET", "/api/Users", key=key)
        user_id = next((user["id"] for user in users if user["username"] == username), None) if status == 200 else None
        if user_id is None:
            sys.exit(f"{username} was not created")
        status, body = call("POST", "/api/Account/update",
                            {"userId": user_id, "username": username, "roles": spec["roles"],
                             "libraries": library_ids,
                             "ageRestriction": {"ageRating": 0, "includeUnknowns": False}}, key=key)
        if status != 200:
            sys.exit(f"Setting roles for {username} failed (HTTP {status}): {body}")
        text = set_env(text, f"TEST_{label}_USERNAME", username)
        if created:
            text = set_env(text, f"TEST_{label}_PASSWORD", confirm["password"])
            print(f"created {username} ({', '.join(spec['roles'])})")
        else:
            print(f"{username} already exists; roles/libraries refreshed, password unchanged")
    ENV.write_text(text)
    print(f"updated {ENV}")

    failures = 0
    for label, spec in ACCOUNTS.items():
        status, _ = call("POST", "/api/Account/login",
                         {"username": spec["username"], "password": env_value(f"TEST_{label}_PASSWORD")})
        print(f"  {spec['username']} sign-in: {'OK' if status == 200 else f'FAILED (HTTP {status})'}")
        failures += status != 200
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
