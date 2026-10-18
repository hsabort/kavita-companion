# Conformance corpus

The language-neutral contract this repository shares with the Python (Lectern) reimplementation of
the naming, identification, path, metadata, media and merge rules. Each case is an `(input →
expected output)` pair named only by the rule ID of
[`docs/companion-rules-v1.md`](../../docs/companion-rules-v1.md), so another implementation can run
the same fixtures without reading our code. Where the corpus and the spec disagree, the spec wins.

## Layout

`*.json` — one file per rule family (`naming.json`, `identify.json`, …), each with a `family` letter
and a `rules` map. The family files are the corpus; do not edit their cases without the spec.

`rules.test.mjs` — the Node runner. It reads every `*.json` here and asserts each case against the
real built rule module under `kavita-companion/dist/`.

## Case fields

| Field | Meaning |
|---|---|
| `in` | The arguments passed to the rule function, positionally. |
| `out` | The expected result per the spec. |
| `current` | The value this implementation returns today when it does not yet meet `out`. The case is asserted against `current` and reported as a tracked divergence, and fails if either value changes. Omit it once `out` is met. |
| `provenance` | Where the expectation comes from (a spec section, or the reason the case exists). Shown in the test name. |
| `runnable` | `false` when the rule has no pure function to call here (it needs the stack or the filesystem). The case is listed as specified-but-not-run rather than failing. |

## Running it

The host has no Node.js, so run it in a container. Build first, then run the runner against the
built `dist`:

```sh
docker run --rm -v "$PWD":/work -w /work/kavita-companion node:24-alpine \
  sh -c 'npm ci --ignore-scripts && npm run build && node --test ../tests/conformance/*.test.mjs'
```

The expected result is **743 tests, 0 failures**; the runner also prints the case count, any tracked
divergences and any specified-but-not-run rules. `npm test` inside `kavita-companion/` does the same
thing (it runs the build and then this runner).

## The one coupling

`RULES` in `rules.test.mjs` is the **only** place a rule ID is tied to a module and function name.
The corpus itself never names a function, so renaming one moves only that map.
