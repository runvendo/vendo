# Install DX: npm install → working agent — Design

**Date:** 2026-07-14 · **Owner:** Yousef · **Linear:** Install DX project (ENG)
**Status:** Approved by Yousef in brainstorm session (this doc is the record).

## Outcome

"Designed for a human dev doing it himself — so simple any agent succeeds too."
`npm install vendoai` → `npx vendo init` → a working, on-brand agent visible in the
dev's own product before the terminal closes. `vendo doctor` proves it independently.
Best possible DX for both plain devs and agent-enabled devs.

## Grounding (examination findings this design responds to)

- The deterministic backbone already exists and is well-tested: init wizard with
  per-change diff consent, framework detection (Next/Express), deterministic
  extraction (OpenAPI + route scan + theme harvest), doctor with static checks +
  one live /status round-trip, `init --agent` JSON plan, `vendo cloud` sub-CLI.
- npm is five weeks stale and one architecture behind: `vendoai` on npm is 0.1.0
  (pre-v0 product); `@vendoai/vendo` and the whole 0.3.0 block set were never
  published. Docs describe software nobody can install.
- Nothing in the install path gets a model credential into the app, so a fresh
  install cannot produce a first working turn.
- No install.md, no llms.txt, no consumer agent surface beyond `--agent` (whose
  plan JSON lacks extraction results). npm package pages have no README.
- Creds research (July 2026): Anthropic bans subscription-OAuth riding in
  third-party products (partner-approval exception exists); OpenAI explicitly
  endorses Codex/ChatGPT-plan riding; CLI-wrapped providers cannot execute the
  host tools bound into Vendo's own agent loop; the compliant industry pattern
  is a vendor-paid gateway (PostHog).

## Scope

Owns the init→doctor→working-agent **journey** and its UX. Extraction engine
quality (incl. the `--deep` AI pass being built in the Extraction project) and
the broader docs site belong to neighbor projects; this project owns what init
invokes, prints, and hands to agents. Framework bar: **Next.js perfect first**;
Express keeps its manual-snippet path.

## Decisions

### 1. The journey
- Install via `vendoai` or `@vendoai/vendo` (both published, same bin).
- `vendo init`: wizard as today (detection stated, per-change diff consent),
  extended with the model-source ladder and cloud steps below.
- **Init ends in the product**: with consent, init starts the dev server, opens
  the browser on the host app with the Vendo surface active, and seeds a first
  turn. **Adaptive seeding**: real tools extracted → live tool demo; theme-only →
  generate an on-brand UI piece; nothing found → self-aware tour of what was
  found and what unlocks next.
- `.vendo/` stays **committed** (only `data/` gitignored); the July-11 design
  text saying "gitignored artifact" is superseded.

### 2. Dev-mode model ladder
Resolved at init; reused by the runtime in dev mode and by extraction `--deep`
(one credential story). Order, with the wizard always stating what it picked:
1. Explicit env key (ANTHROPIC / OPENAI / GOOGLE) — explicit beats implicit.
2. Authed **Claude Code session** (proceeding as-approved per Yousef; consent asked before use).
3. Authed **Codex session** (officially sanctioned by OpenAI).
4. **`vendo cloud login` + free starter allowance** — browser OAuth, console
   mints a metered dev-mode key, the wizard writes `.env.local` itself. The dev
   never pastes a key at any rung.
5. Nothing available → honest 503 with exact instructions (today's behavior).

Production deploys always require a real server-side key; init next-steps and
doctor both say so explicitly.

**Spike (timeboxed, before wave 2 commits):** Agent SDK / Codex app-server as
persistent-process ai-SDK providers with Vendo's host tools bridged via
in-process MCP and consent routed through the permission callback — must
preserve Vendo's approval semantics and interactive latency. Fallback if the
spike fails: CLI rungs power a tools-free first turn (on-brand UI generation);
full tool support lights up on key rungs.

### 3. Agent surfaces
- **install.md** served at a stable URL (vendo.run/install.md + docs-site page):
  single canonical staged playbook (base install → review/remix → block
  unlocks). The 3-line paste prompt points here.
- **llms.txt + per-page .md** on the docs site.
- **Vendo setup skill**: shipped inside the npm tarball; init offers (consent)
  to write it into the host repo's `.claude/skills/`; also published to
  skills.sh (`npx skills add vendo`).
- **Machine-readable CLI**: `doctor --json`, `sync --json`, and `init --agent`
  enriched to include extracted tools + risk recommendations.

### 4. npm artifact (wave 1, before everything)
Publish the 0.3.0 block set + `@vendoai/vendo` + `vendoai` alias; deprecate the
eleven stale 0.1.0 packages with pointers; real READMEs in the tarballs;
eliminate the ghost-dep / floating-`latest`-pin class of generated-file bugs;
fix doc/CLI drift (question counts, undocumented flags).

### 5. Doctor v2
Keep static checks + /status probe. Add: **one real model turn** printed in the
terminal (exit 0 = a user would have gotten an answer), `--json`,
VENDO_API_KEY validation + display of what cloud unlocks, and a consent-gated
offer to start the dev server when nothing is listening.

### 6. Cloud in init
Detect + validate VENDO_API_KEY when present (state what it unlocks; one calm
line when absent). Offer `vendo cloud login` inline. Starter-allowance minting
(console-side endpoint + key semantics in vendo-web) is **built by this
project**; the Cloud console project inherits it.

### 7. Quality bar
All captured against the **published** package, real screen captures:
- Fresh Next starter GIF (install → init → doctor → browser first turn).
- De-wired Maple clone GIF (extraction + on-brand theming wow).
- One corpus repo run (honest real-app proof).
- Agent-driven install GIF (Claude Code + paste prompt completing the install).
- **CI clean-room guard**: recurring job installing the published package into a
  fresh app, running init + doctor + one real turn; fails loudly on npm-vs-main
  drift.

### 8. Execution
Five waves in this session, orchestrated here; codex sol executes (Opus 4.8
only when sol is blocked):
1. Publish 0.3.0 + npm hygiene.
2. Model ladder + runtime dev-mode + init-ends-in-product (spike first).
3. Doctor v2 + cloud-in-init (incl. console allowance pieces).
4. Agent surfaces (install.md, llms.txt, skill, --json).
5. Demos, GIFs, CI guard.

Anthropic partner approval: not pursued now; proceeding as-approved (Yousef's
call, risk flagged and accepted in session).
