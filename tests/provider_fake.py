#!/usr/bin/env python3
"""In-process fake metadata provider for the acceptance tests (stdlib only).

Serves the synthetic fixtures in tests/fixtures/providers/ over HTTP so the portal's provider
framework can be exercised with no network, no real provider and no keys. Records every request
(method, path, query, headers, body) so tests can assert call counts, the User-Agent and the auth
header, and can be scripted per path to return 429 + Retry-After, 500s, oversized bodies or delays.

Default paths: `/stub/*` for the built-in test stub (W1) and `/api/issue/` (search list) plus
`/api/issue/<id>/` (issue detail) for the Metron adapter (W2), served from
`tests/fixtures/providers/<provider>/`.

Used by tests/test_providers_framework.py and tests/test_providers_metron.py (started/stopped there).
The portal reaches it through the Docker gateway: PROVIDER_STUB_BASE=http://<DOCKER_GATEWAY>:<port>
(or PROVIDER_METRON_BASE for Metron). Run standalone with `python3 tests/provider_fake.py <port>`.

    fake = ProviderFake(20900).start()
    ...
    fake.script("/stub/probe", [{"status": 429, "retry_after": 1}, {"json": {"ok": True}}])
    fake.count("/stub/probe")            # requests seen
    fake.last_headers("/stub/")          # headers of the last request
    fake.stop()
"""
import json
import pathlib
import sys
import threading
import time
import http.server

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "providers"


class _State:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = []   # {"method","path","query","headers","body"}
        self.scripts = {}    # exact path -> [response dicts], consumed front-to-back


STATE = _State()


def _fixture(provider, name):
    return (FIXTURES / provider / f"{name}.json").read_bytes()


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _respond(self, response):
        status = int(response.get("status", 200))
        body = b""
        headers = dict(response.get("headers", {}))
        if "delay" in response:
            time.sleep(float(response["delay"]))
        if "json" in response:
            body = json.dumps(response["json"]).encode()
            headers.setdefault("Content-Type", "application/json")
        elif "fixture" in response:
            body = _fixture(response.get("provider", "stub"), response["fixture"])
            headers.setdefault("Content-Type", "application/json")
        elif "raw_bytes" in response:
            body = b"x" * int(response["raw_bytes"])
            headers.setdefault("Content-Type", "application/json")
        elif "body" in response:
            body = str(response["body"]).encode()
            headers.setdefault("Content-Type", response.get("content_type", "text/plain"))
        if "retry_after" in response:
            headers["Retry-After"] = str(response["retry_after"])
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client aborted (e.g. hit the size cap); that is expected

    def _default(self, path):
        # A fake can be scoped to one provider (set at construction). The stub/Metron routing is the
        # default so the existing tests are unchanged; a provider="gcd" fake serves GCD's paths.
        if getattr(self.server, "provider", None) == "gcd":
            if path.startswith("/api/series/name/") or path in ("/api/series", "/api/series/"):
                return {"fixture": "search", "provider": "gcd"}
            if path in ("/api", "/api/"):
                return {"json": {"series": "https://www.comics.org/api/series/",
                                 "publisher": "https://www.comics.org/api/publisher/"}}
            if path.startswith("/api/issue/"):
                return {"fixture": "record", "provider": "gcd"}
            return {"status": 404, "json": {"error": "not found"}}
        if path == "/stub/search":
            return {"fixture": "search", "provider": "stub"}
        if path == "/stub/probe":
            return {"json": {"ok": True}}
        if path.startswith("/stub/record/"):
            return {"fixture": "record", "provider": "stub"}
        # Metron (phase 2, W2): the issue list endpoint and one issue detail.
        if path in ("/api/issue", "/api/issue/"):
            return {"fixture": "search", "provider": "metron"}
        if path.startswith("/api/issue/"):
            return {"fixture": "record", "provider": "metron"}
        return {"status": 404, "json": {"error": "not found"}}

    def _handle(self):
        path, _, query = self.path.partition("?")
        body = self._read_body()
        with STATE.lock:
            STATE.requests.append({
                "method": self.command, "path": path, "query": query,
                "headers": {k: v for k, v in self.headers.items()}, "body": body.decode(errors="replace"),
            })
            script = STATE.scripts.get(path)
            response = script.pop(0) if script else None
        self._respond(response if response is not None else self._default(path))

    do_GET = _handle
    do_POST = _handle

    def log_message(self, *args):
        pass


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A client aborting mid-response (the size-cap test cancels the body) is expected; stay quiet.
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class ProviderFake:
    def __init__(self, port, provider=None):
        self.port = int(port)
        self.provider = provider
        self._server = _Server(("0.0.0.0", self.port), _Handler)
        self._server.provider = provider
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._server.shutdown()
        self._server.server_close()

    def reset(self):
        with STATE.lock:
            STATE.requests.clear()
            STATE.scripts.clear()

    def script(self, path, responses):
        """Queue responses for one exact path; consumed in order, then the default applies."""
        with STATE.lock:
            STATE.scripts[path] = list(responses)

    def requests(self, path_prefix=None):
        with STATE.lock:
            seen = list(STATE.requests)
        return [r for r in seen if path_prefix is None or r["path"].startswith(path_prefix)]

    def count(self, path_prefix=None):
        return len(self.requests(path_prefix))

    def last_headers(self, path_prefix=None):
        seen = self.requests(path_prefix)
        return seen[-1]["headers"] if seen else {}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 20900
    ProviderFake(port).start()
    print(f"fake provider on http://0.0.0.0:{port}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
