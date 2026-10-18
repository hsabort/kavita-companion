# Contributing

**Development has ended (2026-10-18).** This project is frozen and is not accepting pull requests.
The guidance below is kept because it records how the project was built — in particular the
clean-room rule, which is the reason the reusable parts of it are safe to share. Code may still be
reused under the Apache-2.0 licence (see [LICENSE](LICENSE)); for anything else, open an issue rather
than a pull request.

Thanks for looking. This is a small project with an unusually strict provenance rule; the first two
sections below are the ones that matter.

## Licence

kavita-companion is licensed under the **Apache License 2.0** ([LICENSE](LICENSE)). By submitting a
contribution you agree to license it under the same terms. There is no CLA.

## Clean-room rules — the part that matters

This project interoperates with [Kavita](https://github.com/Kareadita/Kavita), which is GPL-3.0. We
must not copy from it. Read [docs/clean-room.md](docs/clean-room.md) in full; in short:

- Kavita is a **behavioural reference only**. Its public documentation, its HTTP API and its observed
  runtime behaviour are fine to work from. Its **source code, database schema, strings and assets are
  not** — do not open, paste, translate or port them, and do not cite its source symbols or file paths
  in code, comments or docs.
- **Dependencies must be permissive** — MIT, ISC, BSD, Apache-2.0, BlueOak, OFL. No GPL, AGPL or LGPL,
  and nothing undeclared. `npm run licences` enforces this and CI runs it; a new dependency that is not
  permissive will fail the build.
- **Never commit anything derived from a real book, comic or user upload.** Test fixtures are synthetic.
- **Do not vendor third-party schemas or assets** (OpenAPI descriptions, logos, icons, fonts we cannot
  redistribute). If you need a schema at runtime, fetch it or link to it.

## AI-assisted contributions

This project is written with AI coding agents under human direction, and that is fine. If your
contribution was produced with AI assistance, say so in the pull request description — what you
directed and what you checked. The clean-room rules above apply to agent output exactly as they apply
to your own typing, and you are responsible for what you submit.

## Commit sign-off (historical)

While the project was under development, contributions were expected to carry a `Signed-off-by` line
certifying the [Developer Certificate of Origin](https://developercertificate.org/), added with
`git commit -s`. The project's own history does not carry a sign-off on every commit, and with
contributions now closed the rule is no longer enforced; it is recorded here only as the original
intent. The sign-off's substance — that a contribution is your own work, or is submitted with the
right to do so, and is not copied from a GPL project — still applies to anyone reusing this code.

## Working on the code

The host needs Docker only; Node runs inside the image. See [docs/development.md](docs/development.md)
for the test stack.

```bash
npm run build      # type-check the server and bundle the web page
npm run licences   # the dependency licence gate
```

The acceptance tests need a running Kavita stack, so they run against the isolated test environment on
the host rather than in CI:

```bash
tests/run.sh --fast      # the quick tier, no library writes — use this while developing
tests/run.sh             # the full tier
```

Add a test for behaviour you change. Where a change affects naming, identification or metadata, the
expected outputs are also part of the language-neutral rule spec in
[docs/companion-rules-v1.md](docs/companion-rules-v1.md) — keep the two in step.

## Pull requests (historical)

These were the rules while the project was active; it no longer accepts pull requests.

- One concern per pull request, with a commit message that says *why*.
- Update [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Keep the style of the surrounding code: comments explain the reasoning, not the mechanics.
- `main` was the deployable branch; pull requests were opened against it.
