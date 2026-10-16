# Product review — plan (baseline audit)

**Date:** 2026-10-16 · **Status:** plan · **Owner:** the human partner (kickoff/severity gate/release).

**Intent (the owner's words):** a sensible baseline *before things get out of the weeds*. Keeping solid
usability and functionality is very important to the spirit of the project, which is making Kavita better
and more useful for its users (mostly the owner). So this review looks for risks and rough edges without
adding scope or disturbing what works.

**How it runs:** read-only review agents work in parallel against the repository and the **test stack**
(Playwright for the UI), and produce one committed findings report with severities plus a remediation
plan. **Nothing on the live stack is touched**, and fixes are spun out as normal tasks.

This is not a build; no design/plan gate applies. The superpowers `brainstorming` questions were offered
and the owner chose sensible defaults, recorded below.

## Goals
- A baseline across five areas: UI/UX, QA, compliance, code/GitHub security, stack security.
- Every finding is **evidence-backed** (repro/screenshot/log/test), severity-ranked, and actionable.
- Highlight and protect **usability and functionality** — the review must not regress either.

## Non-goals
- No rewrite, no new features, no performance work beyond obvious wins.
- No changes to the live stack or host/Incus config as part of the review.

## Anti-goals
- A vibes-only report. Findings without evidence don't count.
- Breaking the live portal, the Kavita library, or real users' data.

## Defaults taken (the questions that would have been asked)
- **Deliverable:** a committed `docs/reviews/<date>-product-review.md` (findings + evidence + severities)
  and a remediation plan; GitHub issues only for items the owner accepts.
- **Scope:** the whole stack (compose + Kavita image + Caddy + portal); live **read-only**, test stack
  active; host notes documented, not changed.
- **Redistribution:** assume public/redistributable (GPL-3.0-or-later) → ShareAlike/attribution in scope.
- **Threat model:** a single self-hosted instance behind HTTPS, admin-reviewed uploads, on a shared
  (Incus/LXC) host; focus on exposure, secrets, SSRF/outbound, archive safety, and container blast radius.
- **Providers:** ComicVine and Google Books stay excluded (decided).
- **Fixes:** spun out as tasks after the report; not done inline during the review.

## Review areas (scope · method · evidence · output)

| # | Area | Method | Evidence | Output |
|---|---|---|---|---|
| 1 | **UI/UX** | Playwright across desktop/phone, keyboard/a11y pass, code read of `public/` + `web/` | screenshots, checklist, console/network | issues w/ severity + suggested fix |
| 2 | **QA** | extend principles: edge cases, **negative testing**, adversarial uploads (fuzz type/size/archive), failure injection, partial-failure, permission boundaries; also **judge test quality** (do tests prove behaviour?) | failing/passing runs, gap analysis | test-gap list + proposed tests |
| 3 | **Compliance** | LICENSE/NOTICE, third-party licences (Kavita assets/fonts), **provider ToS adherence + attribution**, redistribution posture | license/ToS matrix, attribution check | compliance risks + required copy/links |
| 4 | **Code hardening / GitHub** | secret scanning **and history**, `SECURITY.md`, Dependabot/CodeQL, branch protection + required reviews, pinned actions, least-privilege `GITHUB_TOKEN`, SBOM/provenance, release integrity | repo settings + scan output | hardening checklist + gaps |
| 5 | **Stack security** | exposure (ports, PROXY protocol), container hardening (cap-drops, read-only, no-new-privileges), volumes, secrets, SSRF/outbound, archive-safety limits, Kavita/Docker blast radius | config read + probes | threat-model findings + fixes |

## Agent team & assignments
| Role | Owns | Not their job |
|---|---|---|
| **Orchestrator / master reviewer** (me) | severity rubric, sequencing, synthesis gate, all merges/releases | doing each review itself |
| **UI/UX reviewer** | area 1 | backend/security |
| **QA reviewer** | area 2 (extended adversarial suites + test-quality judgement) | fixing code |
| **Compliance reviewer** | area 3 (holds a veto on shipping provider data) | building adapters |
| **Security reviewer** | areas 4 + 5 | UI |
| **Synthesizer / tech writer** | one findings report + remediation plan | changing findings |

## Process (superpowers)
`brainstorming` (owner opted out; defaults recorded) → the review runs as parallel review agents
(`dispatching-parallel-agents`) → `requesting-code-review` per finding batch → `verification-before-completion`
→ the remediation plan becomes tasks via `writing-plans` → fixes via `subagent-driven-development` /
`finishing-a-development-branch`.

## Sequencing & time (elapsed, not man-hours)
| Step | Elapsed |
|---|---|
| R0 kickoff — severity rubric + agent prompts | ~0.5 h |
| R1 parallel review areas (1–5) | ~1–2 h |
| R2 synthesis + severity triage | ~1–2 h |
| R3 remediation plan | ~0.5–1 h |
| **Whole review + plan** | **~1 day** |
| Remediation (after findings) | ~0.5–2 days for the critical/high pass |

Confidence: **low** — it scales with what the reviewers find.

## Deliverables
- `docs/reviews/<date>-product-review.md` — findings, evidence, severities, per area.
- A remediation plan (tasks with estimates, owners).
- Optional: accepted items opened as GitHub issues.

## Playbook — what worked well here (reuse next time)
- **Isolate the work**: a git worktree + one test stack; branch-per-change; **fast/slow/browser test
  tiers**; verify on the test env, never live.
- **Small, single-purpose agents with a master review between each**; the orchestrator owns
  interfaces/contracts and all merges/releases.
- **Background agents + notifications**, sequenced when they'd share files.
- **Fake providers / fixtures** for network-free, deterministic, fast tests.
- **Docs-as-you-go** (`decisions.md`, `kavita-api.md`, roadmap/plan docs) and **versioned GHCR releases**
  with rollback via `COMPANION_IMAGE`.
- **Question-tool decision flow** (one decision at a time, recommendation + ranked alternates).

## Out of scope / deferred
- Fixes themselves (spun out), performance tuning, new features, host/Incus changes.
