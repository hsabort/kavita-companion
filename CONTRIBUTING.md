# Contributing

Thanks for looking. This is a small project with an unusually strict provenance rule, so please read
the first two sections before opening a pull request.

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

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying the [Developer Certificate of
Origin](https://developercertificate.org/):

```
Signed-off-by: Your Name <your@email>
```

Use `git commit -s` to add it automatically. The sign-off certifies that you wrote the contribution,
or have the right to submit it under this project's licence — which, given the clean-room rules, means
you have confirmed it is not copied from a GPL project.

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

## Pull requests

- One concern per pull request, with a commit message that says *why*.
- Update [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Keep the style of the surrounding code: comments explain the reasoning, not the mechanics.
- `main` is the deployable branch; open pull requests against it.
