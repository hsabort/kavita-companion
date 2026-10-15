#!/usr/bin/env python3
"""Call the local Kavita REST API (http://DOCKER_GATEWAY:KAVITA_LOCAL_PORT from .env).

Usage:
  kavita-api.py METHOD PATH [JSON_BODY] [--as USER]

Auth (read from ../.env):
  default      x-api-key: COMPANION_KAVITA_AUTH_KEY   (companion-svc, Admin)
  --as USER    log in with TEST_<USER>_PASSWORD from .env and use a Bearer token
               (USER is uploader, readonly or admin)

Examples:
  kavita-api.py GET /api/Users
  kavita-api.py GET /api/Library/libraries
  kavita-api.py POST /api/Account/update '{"userId": 3, ...}'
  kavita-api.py GET /api/Account/refresh-account --as uploader
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ENV = pathlib.Path(__file__).resolve().parent.parent / ".env"


def load_env():
    env = {}
    for line in ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v.strip().strip("'\"")
    return env


def base_url():
    env = load_env()
    return f"http://{env['DOCKER_GATEWAY']}:{env['KAVITA_LOCAL_PORT']}"


def request(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base_url() + path, data, {"Content-Type": "application/json", **(headers or {})}, method=method
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def main(argv):
    as_user = None
    if "--as" in argv:
        i = argv.index("--as")
        as_user = argv[i + 1]
        del argv[i : i + 2]
    if len(argv) < 2:
        sys.exit(__doc__)
    method, path = argv[0].upper(), argv[1]
    body = json.loads(argv[2]) if len(argv) > 2 else None

    env = load_env()
    if as_user:
        key = as_user.upper()
        status, user = request(
            "POST",
            "/api/Account/login",
            {"username": env[f"TEST_{key}_USERNAME"], "password": env[f"TEST_{key}_PASSWORD"]},
        )
        if status != 200:
            sys.exit(f"login as {as_user} failed: {status} {user}")
        headers = {"Authorization": "Bearer " + user["token"]}
    else:
        headers = {"x-api-key": env["COMPANION_KAVITA_AUTH_KEY"]}

    status, result = request(method, path, body, headers)
    print(json.dumps(result, indent=2) if not isinstance(result, str) else result)
    sys.exit(0 if 200 <= status < 300 else f"HTTP {status}")


if __name__ == "__main__":
    main(sys.argv[1:])
