# Wave 2 — Conformance Suites + CI Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every foundational contract clause gets a named conformance test, and CI stops silently skipping the legs that matter: real Postgres, provider wire formats, the mcp shim, and the corpus pack closure.

**Architecture:** Extend the existing conformance machinery (core's `/conformance` kits, the clause-walking `contract-coverage` pattern, `backends()` dual-backend parameterization) rather than inventing new harnesses. CI gains a real-Postgres service and a `conformance` job on PRs; live provider legs move to a scheduled nightly. Everything lands as one PR, branched off main after PR #148 (Wave 1 amendments) merges — conformance tests pin the *amended* contract text.

**Tech Stack:** vitest, turbo, GitHub Actions, ai-SDK mock/OpenAI-compatible transports. Source of truth: `docs/superpowers/specs/2026-07-14-block-foundations-design.md` + the amended `docs/contracts/`. Linear: ENG-235.

**Ground rules for the executor:**
- Branch `yousefh409/foundations-wave2` off updated `main` (after #148 merges). One PR.
- Conformance tests assert the AMENDED contracts. If a test can only pass by contradicting an amendment, stop and escalate — do not "fix" either side silently.
- No production-code changes in this wave except where a test seam is genuinely missing; each such change must be listed in the PR body under "code touched and why". Behavior changes belong to Waves 3–5.
- The UI wire-type parity task is LAST and gated: do not start it until the orchestrator confirms coordination with the block-ui session.

---

### Task 1: Read the inputs

**Files:**
- Read: `docs/superpowers/specs/2026-07-14-block-foundations-design.md`, all four amended `docs/contracts/` docs
- Read: `packages/core/src/contract-coverage.e2e.test.ts` (the clause-walking pattern to replicate), `packages/core/src/conformance/index.ts`
- Read: `packages/store/src/backends.test-util.ts`, `packages/store/src/postgres-gate.test.ts`, `.github/workflows/ci.yml`, `.github/workflows/perf.yml`
- Read: `packages/agent/src/test-helpers.ts`, `packages/agent/src/live.test.ts`
- Read: `corpus/harness/src/local-pack.ts`; `packages/ui/package.json` (mcp-shim scripts); `packages/apps/src/testing/memory-store.ts`, `packages/guard/test/fixtures/memory-store.ts`
- Read: `packages/vendo/src/type-surface.test.ts` (tsc-backed pattern from the tidy wave, reusable for parity checks)

- [x] **Step 1:** Read all inputs; confirm Wave 1 amendments are on main (contracts show the Amendments sections).
- [x] **Step 2:** List the contract clauses per package that currently lack a named conformance test (gap evidence: core misses a `door-auth` positive leg; store misses audit append-only characterization — deferred to Wave 3 enforcement, so here it gets a *documenting* test of current door behavior marked for Wave 3 flip; agent misses provider wire-format legs beyond Anthropic).

  Gap inventory at execution time: core 01 §7 lacks a positive `door-auth` audit-kind leg and its amended export-surface promises are not inventoried; store 02 §3 lacks contract-to-code reserved-route drift coverage and 02 §2 lacks a Wave-3-flip characterization of the currently mutable audit door; agent 03 §3(4) catalog/theme assembly remains intentionally unimplemented until Wave 5 and lacks a visible skipped conformance case; agent 03 §§2–4 lacks OpenAI-compatible wire-format coverage and OpenAI/proxy live legs.

### Task 2: Real-Postgres leg in PR CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/store/src/postgres-gate.test.ts`

- [x] **Step 1:** Add a `postgres:16` service to the CI test job with health checks; set `POSTGRES_URL` for the test step so `backends()` returns both backends.
- [x] **Step 2:** Make the gate assertive in CI: when `CI=true` and `POSTGRES_URL` is unset, `postgres-gate.test.ts` FAILS (instead of politely noting the skip); locally it keeps today's visible-skip behavior.
- [x] **Step 3:** Run the store suite locally against a disposable Postgres (docker) to shake out any PGlite-only assumptions before CI sees them; fix only test-side issues, escalate code-side ones.
- [x] **Step 4:** Commit.

### Task 3: Per-package conformance suites

**Files:**
- Modify/create tests in `packages/core/src/`, `packages/store/src/`, `packages/agent/src/` (follow each package's existing test layout and naming)

- [ ] **Step 1 (core):** Extend the clause-walk to the amended clauses: `door-auth` positive audit-kind leg; `source: "mcp"` grant leg; export-surface test covers the newly blessed root utilities and the `/conformance` subpath inventory.
- [ ] **Step 2 (store):** Conformance-name the amended §3 routing contract: a test that asserts the routed reserved-collection list in code equals the list in the contract doc (parse `RESERVED_COLLECTIONS` vs the doc's bullet list — drift in either direction fails); a characterization test documenting current `vendo_audit` door mutability, explicitly marked as the behavior Wave 3 flips (mirrors the grant-forge characterization precedent).
- [ ] **Step 3 (agent):** Clause-named tests for 03 §3 assembly order and §4 stream parts already exist — add the missing §3 clause (4) test as a *failing-is-expected* skip-marked test pointing at Wave 5 (catalog/theme wiring), so the gap stays visible.
- [ ] **Step 4:** Add a `conformance` turbo task + CI job that runs exactly these suites (per-package filter or test-name pattern — pick whichever the repo's vitest setup expresses most simply).
- [ ] **Step 5:** Commit.

### Task 4: Provider wire-format conformance (PR CI) + nightly live legs

**Files:**
- Create: agent wire-format test(s) under `packages/agent/src/`
- Create: `.github/workflows/nightly.yml`
- Modify: `packages/agent/src/live.test.ts` (extend the key-gated pattern to OpenAI + proxy)

- [ ] **Step 1:** Wire-format tests: run the full loop (approval pause/resume, blocked-outcome, view parts) against transports that speak each wire format — the existing `MockLanguageModelV3` covers the ai-SDK seam; add an OpenAI-compatible transport leg (ai-SDK `createOpenAICompatible` against a local fake HTTP endpoint replaying recorded OpenAI-format responses) so the OpenAI/proxy path is exercised without keys. Anthropic wire specifics stay covered by the mock + nightly.
- [ ] **Step 2:** Extend `live.test.ts` to three key-gated legs: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VENDO_TEST_PROXY_URL`+key (OpenAI-compatible proxy). Same scripted journey each.
- [ ] **Step 3:** `nightly.yml`: scheduled cron, repo secrets, runs the live legs plus the existing key-gated live suites (live-agentic, live-e2b, live-claude, live-egress, judge.live) and uploads failures visibly.
- [ ] **Step 4:** Commit.

### Task 5: Small gates — shim freshness, corpus pack closure

**Files:**
- Modify: `.github/workflows/ci.yml` (or the conformance job), `corpus/harness/src/local-pack.ts` + its tests

- [ ] **Step 1:** Shim freshness: first check regeneration determinism (`pnpm --filter @vendoai/ui build:mcp-shim` twice, diff). If deterministic → CI step regenerates and `git diff --exit-code` on the generated file. If not → CI runs `test:mcp-shim` (playwright) in the conformance job instead. Record which path was taken and why in the PR body.
- [ ] **Step 2:** Corpus: add `@vendoai/mcp` to `LOCAL_VENDO_PACKAGE_NAMES`; add a closure test asserting every `@vendoai/*` workspace dependency reachable from the umbrella manifest appears in the pack list (so the next added package can't repeat XCUT-4).
- [ ] **Step 3:** Commit.

### Task 6: Test memory-store consolidation

**Files:**
- Modify: `packages/core/src/conformance/index.ts` (`memoryStoreAdapter`)
- Modify: `packages/apps/src/testing/memory-store.ts`, `packages/guard/test/fixtures/memory-store.ts` (become re-exports or get deleted)

- [ ] **Step 1:** Upgrade `memoryStoreAdapter` to mirror the real store's reserved-collection routing semantics (shape validation on reserved names, the same projection behavior), per the amended 02 §3.
- [ ] **Step 2:** Migrate apps and guard test fixtures onto it; delete the parallel implementations; full test suite green.
- [ ] **Step 3:** Commit.

### Task 7: UI wire-type parity test — GATED on block-ui coordination

**Files:**
- Create: parity test in `packages/vendo/` (owns cross-package sight; ui's layering forbids importing the originals)

- [ ] **Step 0 (orchestrator gate):** Confirm with the orchestrator that the block-ui session has been consulted. Do not proceed without it.
- [ ] **Step 1:** tsc-backed structural parity check (pattern: `packages/vendo/src/type-surface.test.ts`) asserting `packages/ui/src/wire-types.ts` shapes are assignable both ways against the originals in apps/automations/agent.
- [ ] **Step 2:** Commit.

### Task 8: Verify and hand back

- [ ] **Step 1:** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green locally (with and without `POSTGRES_URL` set).
- [ ] **Step 2:** Push branch, confirm the new CI jobs actually ran and passed on the PR (not just locally) — read the Actions run.
- [ ] **Step 3:** Report: clause→test mapping added, CI jobs added, which shim-gate path was taken, any code touched and why. Do NOT merge; do NOT flip branch protection (the orchestrator makes `conformance` a required check via repo settings after merge).

---

## Self-review (done at write time)

- Spec coverage: all Wave 2 spec bullets present (Postgres CI, per-clause conformance + required check, provider wire-format + nightly, shim gate, corpus closure, memory-store consolidation, UI parity gated on block-ui).
- Sequencing: branches off main post-#148 so tests pin amended text; required-check flip is post-merge orchestrator work, not in-PR.
- No placeholders; paths exact; behavior changes explicitly fenced to Waves 3–5.
