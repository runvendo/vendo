# Remix Fast Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remix turns stop retyping the whole component: the model emits line-hunk deltas via a new `edit_view` tool against a server-held source baseline, cutting a 30–45 s turn to seconds and structurally eliminating the truncated-JSON 400s.

**Architecture:** Pure delta primitives (baseline normalizer, hunk engine, sealed envelope) land first in `@flowlet/runtime` with TDD; the `edit_view` tool composes them and streams through the exact `render_view` gates; `@flowlet/next` wires enrichment/verification/policy; `@flowlet/shell` pairs the envelope with pins. JSON-repair middleware is ported up from apps/gmail as an independent piece. Everything is spec'd in `docs/superpowers/specs/2026-07-04-remix-fast-edits-design.md` — the plan references its contracts rather than restating them.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), vitest, zod, ai SDK v6, node:crypto (HMAC/HKDF), existing sucrase compile path.

**Ground rules for every task:** TDD (failing test → minimal code → green → commit); `pnpm typecheck && pnpm test` scoped to the touched package before each commit; conventional commit messages; no task leaves the repo red. Per repo rules: feature branch only, PR at the end, no merge.

---

## Phase 0 — contracts (@flowlet/core)

### Task 1: protocol types for baselines and envelopes

**Files:** Modify `packages/flowlet-core/src/protocol.ts` (+ its test if type-level assertions exist there).

- [ ] Change `RemixSourceResolver` to return a **resolved source record** (source text + optional `exportName` + `sourceHash` + `truncated` flag) instead of a bare string, per spec "Baseline" section. Keep the name; update the doc comment.
- [ ] Add the sealed-envelope payload type (spec "Sealed authored-state envelope" field list) and add a `remix-envelope` entry to `FlowletDataParts` carrying the opaque signed envelope string plus the paired `uiNodeId`.
- [ ] Fix all in-repo consumers of the resolver type so the workspace typechecks (mechanical; behavior changes come in later tasks).
- [ ] Commit.

## Phase 1 — pure primitives (@flowlet/runtime), strict TDD

### Task 2: baseline normalizer

**Files:** Create `packages/flowlet-runtime/src/remix/baseline.ts` + `baseline.test.ts`.

- [ ] Tests first, from the spec's baseline contract: LF normalization; named→default export rewrite driven by `exportName` (cover `export function X`, `export const X = `, `export { X }`, already-default no-op, exportName absent → unchanged); stable `baseHash`; exported `NORMALIZER_VERSION` constant; numbered-lines prompt rendering where numbers are furniture (round-trip: numbering never alters the hashed text).
- [ ] Implement minimally; green; commit.

### Task 3: hunk engine

**Files:** Create `packages/flowlet-runtime/src/remix/hunks.ts` + `hunks.test.ts`.

- [ ] Tests first, encoding the spec's exact hunk contract: 1-based `startLine`; coordinates against the original base; atomic apply in descending order; overlap rejection; `oldLines` exact-match requirement with mismatch errors that echo the actual base lines and range; `oldLines: []` insert semantics incl. append at `lineCount + 1`; `\r`/`\n` rejection inside any line string; caps (32 hunks/op, 16 ops/call, 2000 chars/line); `baseHash` precondition failure.
- [ ] Implement minimally; green; commit.

### Task 4: sealed envelope

**Files:** Create `packages/flowlet-runtime/src/remix/envelope.ts` + `envelope.test.ts`.

- [ ] Tests first: mint/verify round-trip over canonical JSON (key-order independence proven); tamper detection on every bound field; cross-anchor and cross-principal rejection; `normalizerVersion` mismatch rejection; internal-consistency checks (`payloadHash`, `sourceHash`); key sourcing precedence — explicit secret, else HKDF from a provider API key, else "sealing unavailable" (mint returns nothing, verify always fails, no throw).
- [ ] Implement with `node:crypto` (HMAC-SHA256, HKDF); green; commit.

### Task 5: JSON-repair middleware port (independent — can merge even if the rest slips)

**Files:** Create `packages/flowlet-runtime/src/json-repair.ts` + test (port `apps/gmail/server/flowlet/json-repair.ts` + its tests); modify `packages/flowlet-runtime/src/engine.ts` to wrap the configured model with the middleware (replacing nothing else); update apps/gmail to import from `@flowlet/runtime` and delete its local copy.

- [ ] Port scanner + middleware with tests verbatim-then-adapt; add an engine-level test that a stream containing a raw-control-char tool input still yields a parsed tool call.
- [ ] Point apps/gmail at the shared export; its existing behavior tests stay green.
- [ ] Commit (separately from other tasks).

## Phase 2 — the tool and the engine

### Task 6: `edit_view` tool

**Files:** Create `packages/flowlet-runtime/src/edit-view-tool.ts` + test; small export additions in the package index.

- [ ] Tests first: zod schema accepts only `editSource`/`addComponent` ops with line arrays; anchor-base materialization produces the spec's deterministic skeleton (one component, root props `{ anchor: { $path: "/anchor" } }`, empty data); pin-base materialization consumes a verified envelope's authored state; the pipeline runs edit-scoped validation (root reachable, generated refs defined, size caps post-join and post-compile) then the same `validateGeneratedPayload` + `hostPropIssues` + compile gates as `render_view`; hunk failure returns a correctable error carrying the echoed lines; success writes one `data-ui` node (with `remixAnchorId`) plus one paired `data-remix-envelope` part minted from the authored state pre-compile.
- [ ] Implement by composing Tasks 2–4 with the existing `compileComponentSource`/validation imports; green; commit.

### Task 7: engine integration

**Files:** Modify `packages/flowlet-runtime/src/engine.ts` + `engine.test.ts`.

- [ ] Tests first: `edit_view` registered iff scoped anchor resolves a non-truncated baseline (or a verified pin base exists); prompt renders the numbered normalized baseline with per-request **nonce delimiters** (replacing the static `<<<FLOWLET_CAPTURED_SOURCE` markers — nonce verified absent from content) and drops the now-server-side named-export instruction; conditional tool guidance ("patch via edit_view; render_view only when no baseline / non-remix / after two failed applies"); remix-tagged `render_view` results also mint envelopes so a first remix is immediately pin-editable; verified pin sources render under the same nonce framing; adversarial test extended — pinned source containing a closing delimiter or instruction text stays inert.
- [ ] Implement; green; commit.

## Phase 3 — host wiring (@flowlet/next)

### Task 8: enrichment record + envelope verification

**Files:** Modify `packages/flowlet-next/src/remix-enrich.ts`, `chat.ts`, `options.ts` + tests.

- [ ] Tests first: resolver returns the full record (exportName/sourceHash/truncated) in both dev re-read and prod captured paths; truncation at the 48 KB cap sets `truncated` (engine then withholds `edit_view` — asserted in Task 7); client-supplied envelope on the scoped anchor is verified before the engine sees it (invalid/absent → anchor base only); seal key sourced from `FLOWLET_SEAL_SECRET` env/option, HKDF fallback from the provider key, neither → sealing off.
- [ ] Implement; green; commit.

### Task 9: policy + agent prompt

**Files:** Modify `packages/flowlet-next/src/default-policy.ts`, `agent.ts` + tests.

- [ ] Tests first: `edit_view` in `ENGINE_ALLOW` (no approval prompt); the "ONE rendering tool" section becomes accurate when `edit_view` is present (conditional text per spec).
- [ ] Implement; green; commit.

## Phase 4 — shell (@flowlet/shell)

### Task 10: envelope through the pin lifecycle + edit UX

**Files:** Modify `packages/flowlet-shell/src/use-flowlet-thread.ts`, `FlowletThread.tsx`, `seams/remixes.ts`, `seams/web-remixes.ts`, `remix/FlowletRemix.tsx`, `remix/scope.ts` + tests.

- [ ] Tests first: pending skeleton shows for `edit_view` input-streaming (same as `render_view`); `data-remix-envelope` parts pair to their `data-ui` node and flow into `applyRemix`; `RemixPin.envelope` persists through the web-storage seam; `AnchorScope.envelope` is sent on scoped open of a pinned anchor; during an edit turn the pinned view keeps rendering until the replacement node lands (no flash to original children).
- [ ] Implement; green; commit. (No new visual surface — the skeleton and pill are existing UI; nothing here needs a Yousef design pause, final look still verified in-browser before the PR.)

## Phase 5 — verification + benchmarks

### Task 11: benchmark harness

**Files:** Create `scripts/remix-bench.mjs` (repo root, plain node) + a short usage note inside the script header.

- [ ] Script drives a running demo host's flowlet chat route with a scoped remix conversation and records, per turn: send→`data-ui` wall-clock, model steps, provider input/output tokens (from stream metadata), tool-input bytes, hunk-failure occurrences. Scenarios per spec: first remix, follow-up edit, forced failed-hunk retry; small/medium/near-cap sources; warm caches (cold first-turn noted separately).
- [ ] Run it on `main` (before) and on this branch (after) against Cadence; save both result sets under `docs/superpowers/specs/assets/` (or inline tables in the PR body).
- [ ] Commit.

### Task 12: real-browser verification + PR

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint` across the workspace.
- [ ] In Cadence (`pnpm demo:accounting`), verify in a real browser: first remix via `edit_view` (fast path), follow-up edit on the pin, forced hunk-mismatch recovery, reset pill, and the no-baseline fallback (anchor without captured source behaves exactly as today). Screenshots of each.
- [ ] Update `docs/` where render_view/remix behavior is described (quickstart / package READMEs) — succinct.
- [ ] Open the PR (never merge): spec + plan links, before/after benchmark tables, screenshots, Codex-review provenance. Update the Orca worktree comment.

---

## Task-order dependencies

1 → (2,3,4,5 in any order, 5 fully independent) → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 2–5 are parallelizable.

## Self-review notes (spec coverage)

Every spec section maps to a task: baseline→2/8, hunks→3, envelope→4/8/10, edit_view+materialization→6, prompt/nonce/adversarial→7, policy/agent→9, shell/UX→10, JSON-repair→5, benchmarks→11, browser verification→12, threat-model assertions→4/7/8 tests. Deferred items in the spec have no tasks by design.
