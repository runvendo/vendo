> Historical session record (frozen). Describes the repo at its date; may not match current code.

# OSS Corpus Testing — Design

**Date:** 2026-07-05
**Status:** Approved by Yousef
**Branch:** yousefh409/new-demos-and-tests

## Goal

Build real testing infrastructure that exercises Vendo against open-source
apps we didn't write. Three purposes, in priority order:

1. **Test `vendo init` at scale** — catch installer regressions (theme
   extraction, tool discovery, component annotation, codemod) on real-world
   codebases.
2. **E2E runtime testing** — verify the full embedded loop (chat, render_view,
   approvals) works inside apps that aren't Maple or Cadence.
3. **Dogfooding ground truth** — a corpus of real apps to validate new
   features against as they're built.

Not a goal: launch/demo material. Polish is irrelevant; coverage is the point.

## Core constraint: zero manual wiring

No Vendo integration code is ever hand-written into a corpus repo. `vendo
init` must carry the entire integration by itself. Per-repo setup recipes may
only cover what the host app needs to run at all (install, env vars, database,
seed data) — never anything Vendo-specific. If a repo can't be integrated
without manual wiring, that is a finding about the CLI, not something to
patch over.

## Prior art the design borrows from

- **vite-ecosystem-ci**: manifest of real downstream repos, scheduled runs,
  local tool build injected into each repo, per-repo status board.
- **shadcn `packages/tests`**: run the real CLI binary against projects,
  assert structure and that the app still builds.
- **SWE-bench**: pinned repos + hand-verified ground truth + a percentage
  scorecard instead of binary red/green, because LLM steps are nondeterministic.
- **Agent e2e practice**: behavioral assertions (tool called, view rendered)
  with pass@k thresholds, never exact-text matching.

## Architecture

Everything lives in a top-level `corpus/` directory in the monorepo,
excluded from the default turbo pipeline.

### Manifest

`corpus/manifest.json` holds one entry per repo: git URL, pinned commit SHA,
license, tier (broad or deep), and a bootstrap recipe (install command, env
template, seed/build/start steps). Repos are cloned on demand into a
gitignored `corpus/.repos/` directory — no foreign code is ever committed,
which also keeps AGPL-licensed corpus repos out of our Apache-2.0 tree.

### Expectations (ground truth)

`corpus/expectations/<repo>/` holds hand-labeled ground truth per repo:

- Theme: expected token values, scored with the existing 7-point
  theme-extractor rubric.
- Tools: expected tool inventory derived from the repo's routes/OpenAPI.
- Components: expected component annotations, including that write-capable
  routes are never auto-allowed (fail-closed).
- Deep tier only: scripted conversations with behavioral assertions.

Labeling is incremental. A repo with no expectations still runs the
structural layer and counts in the scorecard as structural-only.

### Runner

A runner CLI, invoked as `pnpm corpus run [repo] [--layer]`:

1. Clone the repo at its pinned SHA (cached between runs).
2. Run the bootstrap recipe (install, env, seed).
3. Build the local Vendo packages and inject them into the repo via package
   overrides (ecosystem-ci pattern), so the corpus always tests the working
   tree, not the registry.
4. Run `vendo init` with no human intervention.
5. Execute the requested verification layers and emit results into a
   machine-readable scorecard plus a human-readable report.

## Verification layers

### Layer 1 — Structural (deterministic, every repo)

- `vendo init` exits 0.
- Expected files exist and generated config validates against schema.
- The host app still typechecks and builds after init.
- Running init a second time is a no-op (idempotency).
- Annotations fail closed: no write-capable tool is auto-allowed.

### Layer 2 — Scored eval (every repo, as labeled)

Init output graded against the repo's expectations: theme rubric score, tool
inventory precision/recall, annotation correctness. Produces a per-repo score.
Each repo has a recorded baseline; a regression is a score dropping below
baseline, not an absolute threshold — early scores on hard repos will be low
and that's expected.

### Layer 3 — Agent e2e (deep tier only)

- Boot the app with seeded data and the init-produced integration live.
- Playwright drives roughly five scripted conversations per repo against a
  real model (e.g. "show me my unpaid invoices").
- Assertions are behavioral: the expected tool was invoked, a view rendered,
  the approval card appeared for gated actions. Never exact-text.
- Scored pass@k with a per-repo threshold. A single failed LLM run is not a
  regression; a threshold breach is.

## Corpus repos

Stacks and SHAs verified during implementation; list adjusts as reality
dictates.

**Broad tier (~12):** Cal.com, Dub, Papermark, Formbricks, Inbox Zero,
OpenStatus, Umami, Skateshop, Taxonomy, Vercel Commerce, Invoify, Plane.
Deliberate mix: App Router and Pages Router, single-package and monorepo,
MIT and AGPL, tiny to enormous.

**Deep tier (3):**

- **Umami** — MIT, trivially self-hostable, clean seed story.
- **Skateshop** — e-commerce; rich agent domain (products, orders, carts).
- **Papermark** — document sharing; good approval-flow material.

Cal.com stays broad-tier only for now; its self-host setup is a project in
itself.

Expectation: several broad-tier repos (Cal.com, Plane, monorepos generally)
will break `vendo init` immediately. This is the corpus doing its job. Early
scorecards will be red, and phase 1 will spawn CLI fix work as a side effect.
The corpus is not curated down to apps that pass.

## Cadence and CI

- **Local:** every layer runnable with the developer's own API keys via
  `pnpm corpus` commands. This is the primary interface while building.
- **CI:** a nightly scheduled GitHub Actions workflow (plus
  `workflow_dispatch` for on-demand runs) runs the full sweep and publishes
  the scorecard as an artifact, with trend versus previous runs. PR CI is
  untouched — no LLM cost or flakiness added to the merge path.

## Phasing

1. **Runner + manifest + Layer 1** on ~5 repos. Immediately catches "init
   crashes on real code."
2. **Full broad tier + Layer 2 labeling.** The scorecard becomes meaningful.
   Labeling is the largest manual chunk and proceeds incrementally.
3. **Deep tier + Layer 3.** Bootstrap the three apps, write conversation
   scripts, build the Playwright harness.
4. **Nightly CI + scorecard publishing.**

Each phase is independently useful; later phases can be re-scoped after
seeing phase-1 results.

## Risks

- **Label rot:** upstream repos move; pinned SHAs freeze the target, so
  labels only rot when we deliberately bump a pin. Bumping a pin requires
  re-checking that repo's expectations.
- **LLM cost/nondeterminism:** confined to Layer 2/3 and the nightly lane;
  baselines and pass@k absorb variance.
- **Corpus repos are hostile to init today:** expected. Red scorecards are
  findings, and CLI fixes land as separate PRs.
- **Deep-tier bootstrap fragility:** each deep repo's recipe (DB, seed) is
  its own maintenance surface; capped at 3 repos to keep this bounded.
