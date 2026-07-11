> Historical session record (frozen). Describes the repo at its date; may not match current code.

# OSS Corpus Testing Implementation Plan

> **For agentic workers:** Execute task-by-task. Each task is a self-contained
> work packet with acceptance criteria. Steps use checkbox (`- [ ]`) syntax for
> tracking. Spec: `docs/superpowers/specs/2026-07-05-oss-corpus-testing-design.md`.

**Goal:** A corpus of pinned open-source Next.js apps plus a runner that
installs Vendo into each via `vendo init` (zero manual wiring) and verifies
the result through three layers: structural checks, scored evals against
hand-labeled ground truth, and Playwright-driven agent e2e.

**Architecture:** Top-level `corpus/` directory: a manifest of pinned repos
with bootstrap recipes, an expectations directory of ground-truth labels, and
a harness package that clones, bootstraps, injects locally-built Vendo
packages (reusing the CLI's existing local-pack mechanism), runs `vendo init`,
executes verification layers, and emits a scorecard. Nightly GitHub Action
runs the sweep; PR CI is untouched.

**Tech stack:** Node/TypeScript harness package in the pnpm workspace
(vitest for its own unit tests), Playwright for Layer 3, GitHub Actions for
the nightly lane.

**Execution model:** Claude orchestrates; Codex workers (via orca CLI child
workspaces/terminals) execute tasks. One task per worker, review between
tasks. Tasks within a phase are mostly sequential; repo-labeling tasks
parallelize.

**Working rules for every task:**
- TDD where the unit is testable: failing test first, then implementation.
- Commit after each task (conventional commits, small diffs).
- Never commit corpus repo code; `corpus/.repos/` stays gitignored.
- CLI bugs found by the corpus are *findings*: record them in
  `corpus/FINDINGS.md`, do not fix the CLI inside a corpus task.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before
  declaring a task done.

---

## Phase 1 — Runner, manifest, Layer 1 (on 5 repos)

### Task 1: Corpus scaffolding and manifest schema

**Files:**
- Create: `corpus/README.md` (purpose, commands, how to add a repo)
- Create: `corpus/manifest.json` (initial 5 entries)
- Create: `corpus/harness/package.json`, `corpus/harness/tsconfig.json`, `corpus/harness/vitest.config.ts` (private package `@vendoai/corpus-harness`, in pnpm workspace, with `test`/`typecheck` scripts so root CI covers it; no `build` output needed — run via tsx)
- Create: `corpus/harness/src/manifest.ts` + test
- Modify: `pnpm-workspace.yaml` (add `corpus/harness`), root `.gitignore` (add `corpus/.repos/`), root `package.json` (add `corpus` script)

**Steps:**
- [ ] Define the manifest entry shape: name, git URL, pinned SHA, license, tier (`broad`/`deep`), bootstrap recipe (install command, env template as key→value with placeholder markers for secrets, optional seed command, build command, dev-server command + readiness URL for deep tier), and optional notes.
- [ ] Write loader with validation (zod or hand-rolled to match repo conventions — check how `vendo-cli` validates config and mirror it) — failing tests first: rejects missing SHA, unknown tier, duplicate names.
- [ ] Populate initial 5 entries with real pinned SHAs, licenses verified: Umami, Skateshop, Taxonomy, Invoify, Papermark (small-to-medium mix, one monorepo if any of these are). Verify each repo's default branch and current stack (must be Next.js) before pinning; substitute from the spec's broad list if one has migrated away.
- [ ] Wire `pnpm corpus` root script to the harness CLI entry (tsx).
- [ ] Full gate green; commit.

**Acceptance:** manifest loads and validates; `pnpm corpus --help` prints usage; unit tests cover validation failures.

### Task 2: Clone and checkout step

**Files:**
- Create: `corpus/harness/src/clone.ts` + test
- Create: `corpus/harness/src/run-context.ts` (per-repo working dir layout under `corpus/.repos/<name>/`)

**Steps:**
- [ ] Failing tests first (use a local fixture git repo created in a temp dir, not the network): clones at pinned SHA, reuses existing clone by fetching + checkout, detached-head state is fine, dirty working tree is reset (the runner owns `.repos/`).
- [ ] Implement with plain `git` subprocess calls; shallow-fetch the pinned SHA where the host allows it.
- [ ] Commit.

**Acceptance:** repeated runs are idempotent; a corrupted/dirty clone recovers without manual cleanup.

### Task 3: Bootstrap step (install, env)

**Files:**
- Create: `corpus/harness/src/bootstrap.ts` + test

**Steps:**
- [ ] Failing tests first: runs the recipe's install command in the repo dir; materializes `.env` from the recipe's env template, filling secret placeholders from the orchestrating environment (e.g. `CORPUS_<NAME>_<KEY>` env vars) and failing with a clear message listing missing ones; skips install when lockfile + node_modules are already current.
- [ ] Implement. Capture stdout/stderr to per-repo log files under the run context.
- [ ] Commit.

**Acceptance:** bootstrap of a fixture package succeeds; missing-secret error names exactly which env vars to set.

### Task 4: Local Vendo build injection

**Files:**
- Create: `corpus/harness/src/inject.ts` + test
- Read first: `packages/vendo-cli/src/local-pack.ts` and the CLI's existing local/dev flag in `packages/vendo-cli/src/cli.ts` + `init.ts`

**Steps:**
- [ ] Determine how `vendo init` consumes local tarballs today (the CLI already has a local-pack path used for dev). Prefer driving the CLI's own mechanism over re-implementing packing. Record the exact flag/mode in the harness README.
- [ ] Failing tests first for whatever thin layer the harness adds: builds workspace packages once per sweep (not per repo), passes the local mode through to init, verifies the corpus repo's lockfile/package.json ends up referencing the local tarballs and not the registry.
- [ ] Known hazard from prior CI: local-pack breaks on paths with spaces. Corpus paths must avoid spaces; assert and fail early if the workspace path contains one, referencing the known issue in the message.
- [ ] Commit.

**Acceptance:** after injection, the corpus repo resolves `@vendoai/*` from local tarballs; registry versions are never installed.

### Task 5: `vendo init` invocation step

**Files:**
- Create: `corpus/harness/src/init-step.ts` + test

**Steps:**
- [ ] Failing tests first: runs the CLI non-interactively (whatever flags init needs to never prompt — discover them; if init cannot run fully non-interactive, that is finding #1 in `corpus/FINDINGS.md` and the harness passes the answers via documented flags/env), captures exit code, full log, duration, and the git diff of the repo after init.
- [ ] Implement; store artifacts (log, diff, token/cost line if the CLI reports it) in the run context.
- [ ] Commit.

**Acceptance:** init runs unattended against a fixture Next.js app (create a minimal one under `corpus/harness/test/fixtures/`); artifacts land in the run context.

### Task 6: Layer 1 structural checks

**Files:**
- Create: `corpus/harness/src/layers/structural.ts` + test

**Steps:**
- [ ] Failing tests first, one check at a time: init exit 0; expected files exist (enumerate what init generates by reading `packages/vendo-cli/src/init.ts` — config file, route handler, provider wiring, sandbox assets); generated config parses and schema-validates using the CLI's own schema exports; host app typechecks and builds after init (run the repo's own build command from the recipe); second init run is a no-op (empty git diff or an explicit idempotent-success exit); no write-capable tool is auto-allowed (parse the generated tool manifest, assert fail-closed annotations).
- [ ] Each check returns a structured result (id, pass/fail, detail) — no throwing on check failure; the layer reports all results.
- [ ] Commit.

**Acceptance:** all checks run against the fixture app and report structured results; a deliberately broken fixture fails the right checks.

### Task 7: Scorecard and runner CLI

**Files:**
- Create: `corpus/harness/src/scorecard.ts` + test
- Create: `corpus/harness/src/cli.ts` (entry: `run [repo...] --layer 1|2|3 --json`)

**Steps:**
- [ ] Failing tests first: scorecard aggregates per-repo, per-layer results into one JSON document plus a readable markdown table (repo × layer, pass/fail/score, links to logs); exit code reflects hard failures only in `--strict` mode (default is report-everything, exit 0) so early red corpora don't break local flows.
- [ ] Implement CLI orchestration: for each selected repo run clone → bootstrap → inject → init → layers; `--layer` selects layers; failures in one repo never abort the sweep.
- [ ] Commit.

**Acceptance:** `pnpm corpus run umami --layer 1` produces `corpus/.repos/umami/run/scorecard.json` and prints the markdown table.

### Task 8: First real sweep + findings

**Files:**
- Create: `corpus/FINDINGS.md`
- Modify: `corpus/manifest.json` (recipe fixes discovered while running)

**Steps:**
- [ ] Run the full Layer 1 sweep across all 5 repos with real API keys.
- [ ] For each failure, classify: harness bug (fix now), recipe gap (fix manifest now), or CLI/product bug (record in FINDINGS.md with repro command, do not fix).
- [ ] Iterate until every repo either passes Layer 1 or fails only on recorded CLI findings.
- [ ] Commit scorecard summary into FINDINGS.md (scores, not the artifacts).

**Acceptance:** sweep completes end-to-end unattended; FINDINGS.md documents every red cell with a classification. **This task's output gates re-scoping of later phases — review with Yousef before Phase 2.**

## Phase 2 — Full broad tier + Layer 2 scored evals

### Task 9: Remaining broad-tier repos

**Files:**
- Modify: `corpus/manifest.json`

**Steps:**
- [ ] Add the remaining ~7: Cal.com, Dub, Formbricks, Inbox Zero, OpenStatus, Vercel Commerce, Plane. Verify stack (Next.js), pin SHAs, verify license fields, write bootstrap recipes. Drop/substitute any that have migrated off Next.js, noting the substitution in FINDINGS.md.
- [ ] Layer 1 sweep over the new repos; classify failures as in Task 8.
- [ ] Commit.

**Acceptance:** 12 repos in manifest, all sweep without harness crashes; failures are classified findings.

### Task 10: Expectations format and Layer 2 scorer

**Files:**
- Create: `corpus/harness/src/expectations.ts` + test
- Create: `corpus/harness/src/layers/scored.ts` + test
- Create: `corpus/expectations/README.md` (labeling guide: the theme rubric dimensions, how to derive expected tools from routes/OpenAPI, annotation rules)

**Steps:**
- [ ] Define expectations file shape per repo: theme (the 7 rubric dimensions used in the PR #63 evaluation — recover the rubric from that PR's description/diff via `gh pr view 63`), expected tool inventory (name, method, path, read/write classification), expected component annotations.
- [ ] Failing tests first for the scorer: theme dimensions each score 0/1 against extracted output; tools scored as precision/recall over the inventory; annotations scored with write-safety as a hard check (any auto-allowed write = automatic fail regardless of other scores).
- [ ] Baselines: per-repo baseline file (`corpus/expectations/<repo>/baseline.json`) recording the accepted score; scorer flags regression when a run scores below baseline, and prints (but does not auto-commit) an updated baseline when a run scores above.
- [ ] Commit.

**Acceptance:** scorer produces stable scores on fixture data; regression/improvement paths both unit-tested.

### Task 11: Label expectations (parallelizable, one worker per repo batch)

**Files:**
- Create: `corpus/expectations/<repo>/expected.json` for each labeled repo
- Create: `corpus/expectations/<repo>/baseline.json` after first scored run

**Steps:**
- [ ] Batch A (do first): the 5 Phase-1 repos. For each: read the repo's actual design tokens/routes at the pinned SHA and hand-derive ground truth — labels come from the *repo source*, never from what `vendo init` output (that would bake in current behavior as truth).
- [ ] Run Layer 2 on each labeled repo; sanity-check surprising scores by hand; record baselines.
- [ ] Batch B: remaining repos, same procedure, incremental commits (one commit per repo or small batch).

**Acceptance:** every labeled repo has expected.json + baseline.json; the labeling guide was sufficient for a worker to follow without inventing rules (improve it where it wasn't).

## Phase 3 — Deep tier + Layer 3 agent e2e

### Task 12: Deep-tier boot recipes

**Files:**
- Modify: `corpus/manifest.json` (deep-tier fields for Umami, Skateshop, Papermark: DB provisioning, seed, dev-server command, readiness URL, teardown)
- Create: `corpus/harness/src/boot.ts` + test

**Steps:**
- [ ] Failing tests first: boot starts the app (after bootstrap+init), polls readiness URL with timeout, captures server logs, teardown kills the process tree and any provisioned DB container; a failed boot reports the last N log lines.
- [ ] Prefer the lightest DB path per app (SQLite/PGlite where the app supports it; otherwise dockerized Postgres with a fixed port range). Seed with each app's own seed mechanism plus a small deterministic dataset the conversations can rely on (specific invoice/product/document names — document these in the repo's expectations dir).
- [ ] Verify all three deep repos boot seeded, by hand once each, before automating assertions.
- [ ] Commit.

**Acceptance:** `pnpm corpus boot umami` leaves a reachable seeded app; teardown leaves no orphan processes or containers.

### Task 13: Conversation scripts and Playwright harness

**Files:**
- Create: `corpus/harness/src/layers/e2e.ts`
- Create: `corpus/harness/playwright.config.ts`
- Create: `corpus/expectations/<repo>/conversations.json` (per deep repo)
- Read first: `packages/vendo-stage/tests/browser/` for existing Playwright patterns and any shared helpers

**Steps:**
- [ ] Define conversation script shape: user prompt(s), behavioral assertions (tool-called with name matcher, view-rendered with component/role matcher, approval-card-shown, no-error-toast), per-script timeout, k and pass threshold.
- [ ] Harness: boots app (Task 12), opens the embedded Vendo surface, sends scripted prompts, evaluates assertions from observable signals — decide during implementation whether to observe via DOM (approval card, rendered view test-ids) and network (tool endpoints hit), and record the choice in the harness README. Runs each script k times (default 2), scores pass@k.
- [ ] Write ~5 conversations per deep repo grounded in the seeded data (e.g. Umami: "which page had the most views this week"; Skateshop: browse/cart/order flows with approval on the write; Papermark: share-a-document approval flow).
- [ ] Run full Layer 3 per repo; tune assertions that are flaky-by-construction (exact text, timing) into behavioral ones; record thresholds as baselines.
- [ ] Commit.

**Acceptance:** `pnpm corpus run umami --layer 3` completes unattended and scores pass@k; a conversation failing k times is reported with the transcript and screenshots.

## Phase 4 — Nightly CI + scorecard publishing

### Task 14: Nightly workflow

**Files:**
- Create: `.github/workflows/corpus-nightly.yml`
- Modify: `corpus/README.md` (CI section: required secrets, how to trigger)

**Steps:**
- [ ] Scheduled nightly + `workflow_dispatch` (inputs: repo filter, layer filter). Builds workspace once, runs the sweep with `--json`, uploads scorecard + logs as artifacts. Layer 3 needs no external DB services beyond what recipes provision (docker available on ubuntu runners).
- [ ] Trend: job downloads the previous run's scorecard artifact and the report includes per-repo deltas; regression rows highlighted. Post the markdown summary to the workflow run summary page.
- [ ] Secrets: LLM key(s) + any per-repo secrets named `CORPUS_*`; enumerate them in the README; workflow fails fast with a clear message when one is missing.
- [ ] Verify with a `workflow_dispatch` run on a repo-filtered subset before enabling the schedule.
- [ ] Commit.

**Acceptance:** dispatch run green end-to-end on a subset; nightly schedule enabled; scorecard + trend visible in the run summary.

---

## Self-review notes

- Spec coverage: manifest/clone/inject/init (Tasks 1–5), Layer 1 (6), scorecard+runner (7), red-corpus-as-findings (8), broad tier (9), Layer 2 + baselines (10–11), deep tier + Layer 3 pass@k (12–13), nightly CI + trend (14). Zero-wiring rule enforced in working rules and Task 5.
- Deliberate deviations from the writing-plans template: no code snippets (user's global planning rules override the template) and coarser task granularity, because tasks are delegated to Codex workers who receive the acceptance criteria as their brief.
- Known unknowns called out in-task rather than hidden: init's non-interactive surface (Task 5), local-pack spaces hazard (Task 4), rubric recovery from PR #63 (Task 10), repos that may have left Next.js (Tasks 1, 9).
