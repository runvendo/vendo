# Agent Install DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer's coding agent (Claude Code/Codex) completes a Vendo
install end-to-end from a one-line prompt, gated by `vendo doctor --json`.

**Architecture:** URL-first playbook on vendo.run + CLI that narrows it
per-repo (init agent tail, doctor error codes) + the WorkOS auth.md protocol
on Vendo Cloud for in-band key minting + an eval harness that proves agents
actually succeed. Spec: `docs/superpowers/specs/2026-07-19-agent-install-dx-design.md`.

**Repos touched:** this repo (CLI, docs-site, eval), vendo-web (vendo.run
root files, auth.md protocol endpoints).

Per Yousef's global rules this plan is high-level: goals, steps, and
decisions — implementers read the spec and the named files for detail.

---

## Phase order and dependencies

1. **Phase 1 — CLI foundation** (this repo). No dependencies; everything else
   references its flags and error codes.
2. **Phase 2 — Playbook + site surfaces** (docs-site here + vendo-web root).
   Needs Phase 1's final flag names and error-code registry.
3. **Phase 3 — auth.md protocol on Cloud** (vendo-web + small init hook).
   Independent of Phase 2; can run in parallel with it.
4. **Phase 4 — Agent-install eval** (this repo). Needs Phases 1–2 live;
   exercises Phase 3 when available.

Each phase is a separate PR (Phase 3 a vendo-web PR) and produces working,
testable software on its own.

---

### Phase 1: CLI foundation (`packages/vendo`)

**Known constraint:** `--agent` today means "read-only JSON plan, writes
nothing" (see the promise note in `src/cli.ts`). Do NOT overload it. The
agent-driven *scaffolding* path is the non-interactive path (`--yes` + value
flags, or non-TTY); `--agent` keeps its read-only meaning.

- [ ] **Non-interactive value flags for init.** Add value flags covering every
  wizard question (auth preset, framework, cloud key vs BYO). In
  non-interactive mode a missing decision errors with the exact flag name and
  an example invocation — never falls into an interactive prompt. Tests for
  every missing-flag message. Files: `src/cli.ts` (flag tables),
  `src/cli/init.ts`.
- [ ] **Agent tail.** When init scaffolds non-interactively (or stdout is not
  a TTY), the final output is a repo-specific block: auth preset wired and
  what's stubbed, exact files to hand-edit with one-line descriptions, the
  doctor command to gate on. Interactive runs keep the clack-style output
  untouched. Test both modes. Files: `src/cli/init.ts`, `src/cli/pretty.ts`.
- [ ] **Doctor error-code registry.** Give every doctor check a stable
  `error_code` and a `fix_ref` that is a full vendo.run URL (installed
  version as a query param). `--json` already exists — extend its per-check
  shape to `{id, status, error_code, fix_ref}`; nonzero exit until all green
  (verify existing behavior). Registry lives in one module so Phase 2's CI
  check can enumerate it. Files: `src/cli/doctor.ts`, `src/cli/doctor-live.ts`,
  new registry module beside them.
- [ ] **Star prompt (interactive only).** After a successful interactive init:
  `Star runvendo/vendo to support the project? [Y/n]`; yes runs the star via
  `gh`, missing `gh` prints the repo link. Never shown non-interactively.
  Skippable, never blocks completion, failure is silent-but-logged. Files:
  `src/cli/init.ts`.
- [ ] **Gate + PR.** `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
  green; PR against main.

### Phase 2: Playbook + site surfaces (docs-site + vendo-web)

Content is authored against Phase 1's real flags and error codes — every
command in the playbook must be copy-paste runnable.

- [ ] **Write the four playbook pages** in docs-site: `agents` hub (~1 page:
  three-sentence pitch, numbered install flow, rules of engagement, star ask
  as required final step), `host-auth` (5 presets: detection, wiring, when to
  ask the human), `tools` (two-file surface, catalog contract,
  anti-prop-invention rules), `verify` (one section per doctor error code:
  symptom → cause → fix; anchors match `fix_ref` URLs).
- [ ] **vendo.run root `agents.md`** (vendo-web): serve the hub at the domain
  root as raw markdown (redirect or mirror of the docs page — pick whichever
  Mintlify + vendo-web routing makes canonical, document the choice).
- [ ] **Prompt blocks.** The north-star copy-paste prompt (spec wording) on
  the docs install page and the repo README.
- [ ] **Mintlify freebies audit.** Confirm enabled and working on our plan:
  llms.txt, llms-full.txt, skill.md, `.md` content negotiation per page, docs
  MCP server, contextual menu. Enable what's off; note anything unavailable.
- [ ] **Registry-rot CI check.** A test/CI step in this repo asserting every
  error code the doctor registry can emit has a matching `verify` page anchor
  (docs live in-repo, so this is a plain test against the docs-site source).
- [ ] **Gate + PRs.** Docs render verified in a real browser (screenshots in
  PR per repo rules); vendo-web PR for the root file.

### Phase 3: auth.md protocol on Vendo Cloud (vendo-web + init hook)

Rides the existing mint/gateway zero-key path (live since the init-cli lane).
Read the WorkOS spec (auth-md.com) before implementing; follow it exactly —
the point is that agents already know this protocol.

- [ ] **Discovery metadata.** Publish `vendo.run/auth.md` and
  `/.well-known/oauth-protected-resource` (RFC 9728) describing scopes and
  endpoints.
- [ ] **User-claimed flow** (v1): device-code style per RFC 8628 — agent
  registers, receives user code + verification URI, human confirms once in
  the browser, agent polls token endpoint, receives a VENDO_API_KEY-minting
  credential. Wire to the existing mint service; rate-limit and expire codes.
- [ ] **Identity-assertion flow** (ID-JAG): implement verification behind a
  trust list of agent-provider keys; ship dormant/flagged until providers
  actually issue assertions. Smallest honest version — no speculative UI.
- [ ] **Init hook** (this repo): when the human chooses Cloud and no key
  exists, init points the agent at the auth.md flow (or runs it) and writes
  the minted key to `.env`. Keep the existing manual paste path as fallback.
- [ ] **Gate + PRs.** End-to-end manual test: a real Claude Code session
  mints a key via the user-claimed flow. Security review of the new
  endpoints before merge (`/security-review`).

### Phase 4: Agent-install eval

Same muscle as `corpus/` — extend it rather than inventing a parallel harness.

- [ ] **Harness.** Given a clean fixture repo (corpus repos + demo-bank +
  demo-accounting), run headless Claude Code with only the copy-paste prompt.
  Record the transcript and final repo state.
- [ ] **Scoring.** Per run: reached doctor-green (pass/fail), turn count,
  asked-before-account/key (transcript check), playbook violations
  (hand-wrote scaffold files, invented tools/props, skipped star ask).
- [ ] **Matrix + report.** Run across fixtures; report like the v2
  generalization matrix. Failures become doctor error codes + `verify`
  sections before being called fixed — encode that rule in the report
  template.
- [ ] **Gate + PR.** Harness runs locally with one command; document cost per
  run; not wired into CI by default (live-model spend).

---

## Verification (whole lane)

- The copy-paste prompt is literally true end-to-end: a fresh Claude Code
  session given only the prompt reaches doctor-green on demo-bank.
- Doctor failure → fix_ref URL → fix → green loop demonstrated in a real
  transcript.
- Star ask appears exactly once per path, consent-framed, never blocks.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green per PR;
  UI/docs changes verified in a real browser with screenshots.

## Out of scope (restated from spec)

Web Bot Auth; shipped Claude Code skill/plugin; prod deploy path; frameworks
beyond Next.js + Express; any non-consented starring.
