# Provider test fixtures

Hand-written, **synthetic** payloads shaped like the fields each provider adapter reads. They contain
no real provider data, no real names, no URLs and no keys (compliance M9: fixtures are never rehosted
provider content). Edits are reviewable diffs.

Layout: one directory per provider. For the built-in test stub (`PROVIDERS_STUB=true`, W1 framework):

- `stub/search.json` — a search result list (candidates, with a score).
- `stub/record.json` — one full record, with HTML in `Summary` to exercise the plain-text hook.

For the Metron adapter (`PROVIDER_METRON_BASE`, W2) — served for `/api/issue/` and `/api/issue/<id>/`:

- `metron/search.json` — a Metron issue-list page (`results[]`, each with a nested `series`/`publisher`).
- `metron/record.json` — one full issue detail: nested `series` (genres/language/volume/year_began),
  `publisher`, `imprint`, `credits` (creator + roles), `arcs`/`characters`/`teams`, `rating`, `desc`,
  with HTML in `title`/`desc` to exercise the plain-text hook.

`tests/provider_fake.py` serves these and can be scripted (429 + `Retry-After`, 500, oversized body,
HTML) from a test; `tests/test_providers_framework.py` and `tests/test_providers_metron.py` start and
stop it.
