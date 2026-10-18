# Agent notes — kavita-companion

Cross-tool agent instructions for this repository. See also `CLAUDE.md` for host/environment
specifics (container, ports, test worktree, live-user safety).

## Lectern coordination

This project is being integrated into **Lectern**, a separate project built by JP's agents on
another machine.

- **Channel.** Communicate with the Lectern agents **only** through the shared directory
  `/srv/kavita-companion/scratchpad/lectern`. No other channel.
- **Protocol.** Follow `/srv/kavita-companion/scratchpad/lectern/PROTOCOL.md` (Lectern SPEC §12).
  If that file is not present yet, do not invent a protocol — flag the gap and wait for it.
- **Agent ID.** Our agent ID is **`companion`**. Use it to identify ourselves in every exchange.

### Rules for the shared directory

- **Everything relevant to the Lectern project must always be noted there.** Lectern reviews our
  documentation, and material left only in this repository will be caught up in this repository's
  own review. When in doubt, write it to the shared directory.
- **Everything written into that directory must be `chmod 666`** (world read/write), so any agent
  on the host can read and update it. The directory itself keeps its execute bit.
- **That directory is deliberately outside version control.** It holds JP's proprietary Lectern
  spec, which must never be committed. Do not add it to the repository.

### Working documents

The shared directory's `README.md` is the index. Current contents:

- `2026-10-18-lectern-initial-spec.md` — JP's Lectern spec + JP/Jim answers.
- `2026-10-18-kavita-companion-lectern-compliance.md` — the project plan (four gates, six phases).
- `2026-10-18-lectern-cleanroom-audit.md` — clean-room + relicensing + attribution audit.
- `2026-10-18-lectern-dependency-inventory.md` — dependency licences + provenance.
- `2026-10-18-lectern-feature-inventory.md` — behaviour inventory mapped to M0–M5.
- `2026-10-18-lectern-architecture-note.md` — port surface, data-model mapping, delivery options.
- `2026-10-18-lectern-metadata-research.md` — Jellyfin/Radarr/Calibre/ComicInfo conventions.
- `2026-10-18-review-overview.md` — part-by-part overview + overall assessment.

### Current position (as of 2026-10-18)

- `kavita-companion` continues to run as the Kavita-side upload/correction tool.
- Our job is **not** to build Lectern — it is to make our code and the rules it encodes available
  to it.
- The delivery recommendation is a **language-neutral rule spec + fixture corpus** that Lectern
  reimplements in Python, so no code crosses the GPL boundary.
- Four decisions are outstanding and blocking: relicensing grant, delivery mechanism, artefact
  boundary, and the read-only-mount vs metadata-write-back conflict. Details in the plan's §0.

## Safety (unchanged)

Never touch live users' uploads or library files; `main` stays deployable; do no destructive work
against `/srv/media` without explicit go-ahead. Full detail in `CLAUDE.md`.
