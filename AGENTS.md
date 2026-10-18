# Agent notes — kavita-companion

Cross-tool agent instructions for this repository. See also `CLAUDE.md` for how to work here
(container, tests, live-user safety).

## Coordination with a partner project

Part of this work is coordinated with a separate project built by another team, in a separate
repository. Keep the two repositories separate — nothing from that project is committed here.

- **Channel.** Talk to the other team **only** through the shared directory outside this repository
  (ask the maintainer for the path). Do not open a second channel.
- **Protocol.** Follow the `PROTOCOL.md` in that directory. If it is not present yet, do not invent a
  protocol — flag the gap and wait for it.
- **Agent ID.** Our agent ID is **`companion`**. Use it to identify ourselves in every exchange.

### Rules for the shared directory

- **Everything relevant to the partner project must always be noted there.** When in doubt, write it
  to the shared directory rather than leaving it only in this repository.
- **Everything written into that directory must be `chmod 666`** (world read/write), so any agent on
  the host can read and update it. The directory itself keeps its execute bit.
- **That directory is deliberately outside version control** and holds third-party proprietary
  material. Never add it to the repository, and never commit anything from it.

## Safety

Never touch live users' uploads or library files; `main` stays deployable; do no destructive work
against the media root without explicit go-ahead. Full detail in `CLAUDE.md`.
