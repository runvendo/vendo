# Init Self-Contained Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make init's consented AI pass self-contained (codex driver + npx-fetched Claude Code engine) and enforce the free-plan no-gateway-tokens policy server-side.

**Spec:** `docs/superpowers/specs/2026-07-20-init-builtin-agent-harness-design.md`

**Architecture:** Everything extends the theme-detect lane's `ExtractionHarness` seam (`packages/vendo/src/cli/extract/harness.ts`: `id` / `availability` / `run`). Two new harnesses join the ladder (codex CLI, npx engine); a gateway-fuel env layer makes `VENDO_API_KEY` usable as Claude Code credentials; the console refuses init-tagged inference for free orgs. Two repos, three PRs: flowlet harness work, flowlet engine package, vendo-web policy.

**Preconditions (do not start before):**
- Theme-detect lane's harness/stage tasks and api-detect lane's held init-wiring tasks are on `main` (the harness files this plan touches live on `yousefh409/theme-detect` today).
- Coordinate with the theme-detect session before touching `packages/vendo/src/cli/extract/*` (reply channel in that lane's memory).
- Publishing `@vendoai/engine` stays blocked on NPM_TOKEN with every other release item; all other tasks can land before publish.

---

## Part A — flowlet: harnesses and ladder (PR 1)

### Task 1: Codex CLI harness

**Files:** create `packages/vendo/src/cli/extract/codex-cli-harness.ts` + its test file, mirroring `claude-cli-harness.ts` and its scripted-spawn test seam.

- [ ] Write failing tests first: availability (codex on PATH and authenticated; absent; present-but-unauthenticated returns null so the ladder falls through), headless run happy path, artifact parsed from machine-readable output, non-zero exit surfaces a degradation error. Use a scripted spawn seam; no real codex in unit tests.
- [ ] Implement: availability probe, non-interactive `codex exec` invocation with read-only sandbox flags, final-message capture, reuse of the existing `parseArtifact` helper. Credential story: ChatGPT login or `OPENAI_API_KEY`.
- [ ] Verify the suite passes, then commit.

### Task 2: Engine ladder with fall-through

**Files:** modify the harness selection in `packages/vendo/src/cli/extract/index.ts` (and its tests).

- [ ] Tests first: resolution order is Agent SDK → claude CLI → codex CLI → npx engine; a rung whose availability is null (missing or unauthenticated) falls through; the consented-but-nothing-available skip message names every rung tried and the exact fixes (per spec's degradation section).
- [ ] Implement the ordered ladder; keep each harness's availability label in the skip message.
- [ ] Verify, commit.

### Task 3: Gateway fuel for Claude Code rungs

**Files:** new small module under `packages/vendo/src/cli/extract/` for credential/env composition + tests; wire into the claude-CLI and npx-engine harness launches.

- [ ] Tests first: when own Anthropic credentials exist, env passes through untouched; when absent but `VENDO_API_KEY` is set, the launch env carries the gateway base URL (from `resolveCloudBaseUrl`), the key as the auth token, and the init-purpose tag header (Claude Code's custom-headers mechanism); a structured gateway refusal is relayed to the user verbatim, not swallowed.
- [ ] Implement; the tag header name is one shared constant exported for the console tests to mirror.
- [ ] Verify, commit.

### Task 4: npx engine harness

**Files:** create `packages/vendo/src/cli/extract/npx-engine-harness.ts` + tests.

- [ ] Tests first (scripted exec seam, no real download): availability requires a usable credential (own key or `VENDO_API_KEY`) and reports the download-size notice in its label; run invokes `npm exec` on `@vendoai/engine` at an exact pinned version constant; the serialized job (instructions, root, artifact expectations) round-trips; offline/exec failure degrades to the honest skip.
- [ ] Implement, including the visible first-run download notice through `onProgress`.
- [ ] Verify, commit. Browser/live proof is not applicable; this is CLI-only.

## Part B — flowlet: the engine package (PR 2)

### Task 5: `@vendoai/engine` package

**Files:** create `packages/engine/` (package.json, thin runner entry, tests); add to the workspace build and the dependency guard's layering config; add a publish-pipeline entry alongside the other `@vendoai/*` packages.

- [ ] Tests first: the runner accepts a serialized harness job on stdin, executes it through the Agent SDK seam (scripted in tests), writes the final text to stdout, exits non-zero on failure with a structured error; settings are isolated so the dev's personal Claude Code config cannot leak in; tool policy is read-only rooted at the given directory.
- [ ] Implement the runner with `@anthropic-ai/claude-agent-sdk` as its only substantial dependency. No init logic, no vendo imports beyond shared types — the package stays command-agnostic per the spec.
- [ ] One gated live test (env-flagged, like `extract-theme.live.test.ts`) proving a real end-to-end stage run through the packed package.
- [ ] Verify `pnpm build && pnpm test && pnpm typecheck && pnpm lint`, commit.

### Task 6: Corpus legs

**Files:** corpus workflow config additions only; do not touch harness bootstrap/injection code (another lane's surface) beyond what its owner agrees to.

- [x] Add informational codex and npx-engine legs to the nightly matrix, gated on their credentials being present.
- [x] File (not do) the follow-up: remove the harness's `@ai-sdk/anthropic` injection once the engine rung is live in a nightly.
- [x] Commit.

## Part C — vendo-web: free-plan policy (PR 3, can land any time before Part A ships)

### Task 7: Init inference policy in the gateway

**Files:** modify `apps/console/lib/api/messages-gateway.ts`, the plans data (migration adding the per-plan init-inference flag: free refuses, paid allows; org override via the existing `subscriptions.overrides`), plus `apps/console/tests/` coverage.

- [ ] Tests first: the policy matrix (free/paid × tagged/untagged × override set/unset); refusal is a structured error with the honest upgrade-or-bring-your-own message; allowed init traffic still meters `llm_tokens` normally; untagged traffic is completely unaffected.
- [ ] Implement: read the tag header (same constant as Task 3), resolve plan via the existing plan-resolution path, check the flag, refuse or pass through.
- [ ] Verify console suite green, commit.

---

## Verification (whole program)

- Both repos: full green gates (`pnpm build && pnpm test && pnpm typecheck && pnpm lint`).
- Live proof for the PR: one recorded init run on a clean machine profile with no claude/codex on PATH and a paid-org `VENDO_API_KEY` (download notice → engine runs → metered), and one with a free-org key (server refusal relayed). CLI transcript evidence in the PR; no UI change, so no screenshots needed.
- Docs sync after landing: init docs mention the auto-fetched engine, its size, cache location, and the free-plan policy.

## Follow-ups

- Remove the corpus harness's `@ai-sdk/anthropic` injection into cloned repos
  (see `corpus/harness` bootstrap/injection code) once the npx-engine rung is
  proven live in a nightly run (`npx-engine-leg` in
  `.github/workflows/corpus-nightly.yml`, Task 6) — the injection was a
  stand-in for host-side model access that the engine rung now covers, but
  pulling it before the rung has nightly evidence would remove coverage with
  nothing proven to replace it. Filed, not done, by Task 6.
