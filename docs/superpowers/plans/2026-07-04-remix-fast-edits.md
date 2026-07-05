# Remix Fast Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remix turns stop retyping the whole component: the model emits line-hunk deltas via a new `edit_view` tool against a server-held source baseline, cutting a 30–45 s turn to seconds and structurally eliminating the truncated-JSON 400s.

**Architecture:** Pure delta primitives (baseline normalizer, hunk engine, sealed envelope) land first in `@flowlet/runtime` with TDD; the `edit_view` tool composes them and streams through a materialization helper shared with `render_view`; `@flowlet/next` wires enrichment/verification/seal-key plumbing before the engine integration lands; `@flowlet/shell` pairs the envelope with pins. JSON-repair middleware is ported up from apps/gmail as an independent piece. Contracts live in `docs/superpowers/specs/2026-07-04-remix-fast-edits-design.md` — the plan references them rather than restating.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), vitest, zod, ai SDK v6, node:crypto (HMAC/HKDF), existing sucrase compile path.

**Ground rules for every task:** TDD (failing test → minimal code → green → commit); `pnpm typecheck && pnpm test` scoped to the touched package before each commit; conventional commits; no task leaves the workspace red. Per repo rules: feature branch only, PR at the end, no merge.

**Task order (revised after plan review):** 1 → (2, 3, 4, 5 in any order; 5 fully independent) → 6 → 8 → 7 → 9 → 10 → 11 → 12. Task 8 precedes 7 because the engine can only see records/envelopes once enrichment produces them.

---

## Phase 0 — contracts (@flowlet/core)

### Task 1: protocol types for baselines and envelopes

**Files:** Modify `packages/flowlet-core/src/protocol.ts`; mechanical consumer fixes in `packages/flowlet-next/src/{remix-enrich.ts,chat.ts,options.ts,handler.ts,flowlet-dir.ts}` + their tests, `packages/flowlet-runtime/src/engine.ts` (type-level only), and `apps/demo-accounting/src/flowlet/chat-handler.ts` (custom resolver).

- [ ] Add a NEW `ResolvedRemixSource` type — `{ source, exportName?, sourceHash, truncated }` — used by the resolver/enrichment/engine path. `RemixSourceRecord` (persisted by `flowlet sync`) is untouched, so CLI capture files and tests do not churn.
- [ ] `RemixSourceResolver` returns `ResolvedRemixSource | undefined`. The engine-facing anchor block replaces `scoped.source?: string` with `scoped.remixSource?: ResolvedRemixSource` (no legacy field kept — all consumers are in-repo).
- [ ] Add the sealed-envelope payload type (spec field list), `scoped.envelope?: string` on the client-supplied scope (raw, unverified), a server-only `VerifiedPinBase` handoff type (authored payload + sources + baseHash), and a `remix-envelope` entry in `FlowletDataParts` carrying `{ envelope: string, uiNodeId: string }`.
- [ ] Fix all consumers so the workspace typechecks (behavior unchanged; enrichment temporarily adapts records to the new shape).
- [ ] Commit.

## Phase 1 — pure primitives (@flowlet/runtime), strict TDD

### Task 2: baseline normalizer

**Files:** Create `packages/flowlet-runtime/src/remix/baseline.ts` + `baseline.test.ts`.

- [ ] Tests first, from the spec's baseline contract: LF normalization; named→default export rewrite driven by `exportName` (cover `export function X`, `export const X = `, `export { X }`, already-default no-op, exportName absent → unchanged); stable `baseHash`; exported `NORMALIZER_VERSION` constant; numbered-lines prompt rendering where numbers are furniture (numbering never alters the hashed text).
- [ ] Implement minimally; green; commit.

### Task 3: hunk engine

**Files:** Create `packages/flowlet-runtime/src/remix/hunks.ts` + `hunks.test.ts`.

- [ ] Tests first, encoding the spec's exact hunk contract: 1-based `startLine`; coordinates against the original base; atomic apply in descending order; overlap rejection; `oldLines` exact-match with mismatch errors that echo the actual base lines and range; `oldLines: []` insert semantics incl. append at `lineCount + 1`; `\r`/`\n` rejection inside any line string; caps (32 hunks/op, 16 ops/call, 2000 chars/line); `baseHash` precondition failure.
- [ ] Implement minimally; green; commit.

### Task 4: sealed envelope

**Files:** Create `packages/flowlet-runtime/src/remix/envelope.ts` + `envelope.test.ts`.

- [ ] Tests first: mint/verify round-trip over canonical JSON (key-order independence proven); tamper detection on every bound field; cross-anchor and cross-principal rejection; `normalizerVersion` mismatch rejection; internal-consistency checks (`payloadHash`, `sourceHash`).
- [ ] Expose a `RemixSealer` interface (mint/verify) plus `createRemixSealer(keyMaterial)`; key sourcing itself lives in the adapters (Task 8) — the runtime only consumes a sealer. No sealer → minting skipped, `base:"pin"` never offered (no throw).
- [ ] Implement with `node:crypto` (HMAC-SHA256, HKDF for derived keys); green; commit.

### Task 5: JSON-repair middleware port (independent — mergeable even if the rest slips)

**Files:** Create `packages/flowlet-runtime/src/json-repair.ts` + test (port `apps/gmail/server/flowlet/json-repair.ts` + tests); modify `packages/flowlet-runtime/src/engine.ts`; modify apps/gmail to REMOVE its app-level model wrapper and local copy.

- [ ] Port scanner + middleware with tests; engine wraps the configured model with it.
- [ ] Per spec, this REPLACES the engine's current after-the-fact `{}` fallback in `normalizeHistory` (engine.ts ~331): remove that branch; add an engine test proving a historical assistant tool input with raw control chars reaches the model as the repaired parsed object, not `{}` (and an unrepairable one still degrades safely).
- [ ] Delete gmail's local middleware + wrapper wiring; its behavior tests stay green against the shared export.
- [ ] Commit (separately from other tasks).

## Phase 2a — the tool (@flowlet/runtime)

### Task 6: shared materialization + `edit_view` tool

**Files:** Create `packages/flowlet-runtime/src/edit-view-tool.ts` + test; extract `packages/flowlet-runtime/src/materialize-view.ts` (the validate→compile→write-node path) out of `render-view-tool.ts` so BOTH tools share it; package index exports.

- [ ] Extract first (pure refactor, render_view tests stay green); commit.
- [ ] Tests first for `edit_view`: zod schema accepts only `editSource`/`addComponent` ops with line arrays (`\r`/`\n` rejected at schema level); anchor-base materialization produces the spec's deterministic skeleton (one component, root props `{ anchor: { $path: "/anchor" } }`, empty data); pin-base materialization consumes a `VerifiedPinBase`; edit-scoped validation (root reachable, generated refs defined, size caps post-join and post-compile) precedes the shared `validateGeneratedPayload` + `hostPropIssues` + compile gates; hunk failure returns a correctable error carrying the echoed lines; success writes one `data-ui` node (with `remixAnchorId`) plus one paired `data-remix-envelope` part minted from the authored state pre-compile via the configured sealer.
- [ ] Optional dev timing: behind `FLOWLET_BENCH=1`, log hunk-apply/validate/compile durations (consumed by Task 11).
- [ ] Implement by composing Tasks 2–4; green; commit.

## Phase 3a — host wiring that the engine needs first (@flowlet/next)

### Task 8: enrichment record, envelope verification, seal-key plumbing

**Files:** Modify `packages/flowlet-next/src/{remix-enrich.ts,chat.ts,options.ts,handler.ts,world.ts,agent.ts}` + tests; `apps/demo-accounting/src/flowlet/chat-handler.ts` follows the new contract.

- [ ] Tests first: resolver returns `ResolvedRemixSource` (exportName/sourceHash/truncated) in both dev re-read and prod captured paths; truncation at the 48 KB cap sets `truncated`; client-supplied `scoped.envelope` is stripped from history like `scoped.source` today, verified only on the last user message, and the engine receives a `VerifiedPinBase` (invalid/absent → none); seal key sourcing — `sealSecret` handler option, else `FLOWLET_SEAL_SECRET` env, else HKDF from `process.env.ANTHROPIC_API_KEY` on the default-model path, else sealing off.
- [ ] Add `sealSecret?: string` to `FlowletHandlerOptions`; adapters build the `RemixSealer` and pass it (plus the verified pin base) through `handler.ts → agent cache → createFlowletAgent` via new `FlowletAgentConfig` fields (`remixSealer?`, and the anchor block's `remixSource`/pin base already typed in Task 1).
- [ ] Implement; green; commit.

## Phase 2b — engine integration (@flowlet/runtime)

### Task 7: engine registration, prompt, nonce framing

**Files:** Modify `packages/flowlet-runtime/src/engine.ts` + `engine.test.ts`.

- [ ] Tests first: `edit_view` registered iff scoped anchor has a non-truncated `remixSource` (pin base additionally enables `base:"pin"`); prompt renders the numbered normalized baseline with per-request **nonce delimiters** (replacing static `<<<FLOWLET_CAPTURED_SOURCE` markers; nonce verified absent from content) and drops the now-server-side named-export instruction; conditional tool guidance ("patch via edit_view; render_view only when no baseline / non-remix / after two failed applies") with one worked first-remix example (props→`data.anchor` glue as hunks); remix-tagged `render_view` results also mint envelopes so a first remix is immediately pin-editable; verified pin sources render under the same nonce framing; adversarial test extended — pinned source containing a closing delimiter or instruction text stays inert.
- [ ] Implement; green; commit.

## Phase 3b — policy + prompts everywhere they are copied

### Task 9: default policy, agent prompt, demo apps

**Files:** Modify `packages/flowlet-next/src/{default-policy.ts,agent.ts}` + tests; `apps/demo-accounting/src/flowlet/{policy.ts,agent.ts}`; `apps/demo-bank/src/flowlet/policy.ts`; `apps/gmail/server/flowlet/policy.ts` (+ any prompt copies naming "ONE rendering tool") + their tests.

- [ ] Tests first: `edit_view` allowed without approval in the default policy AND each demo policy; prompt text accurate when `edit_view` is present (conditional per spec). Cadence is the benchmark host — its policy/prompt MUST be updated or Tasks 11/12 measure an approval-gated path.
- [ ] Implement; green; commit.

## Phase 4 — shell (@flowlet/shell)

### Task 10: envelope through the pin lifecycle + edit UX

**Files:** Modify `packages/flowlet-shell/src/{use-flowlet-thread.ts,FlowletThread.tsx,components/MessageList.tsx,seams/remixes.ts,seams/web-remixes.ts,remix/FlowletRemix.tsx,remix/scope.ts}` + tests (`use-flowlet-thread.test`, `message-list.test.tsx`, `remixes.test.ts`, `web-remixes.test.ts`, `FlowletRemix.test.tsx`).

- [ ] Tests first: pending skeleton shows for `edit_view` input-streaming (same as `render_view`); `data-remix-envelope` parts pair to their `data-ui` node by `uiNodeId` — `ThreadItem`/`onApplyRemix`/latest-node plumbing carries `{ node, envelope? }`, covered for BOTH orderings (envelope part before the ui part and after); `RemixPin.envelope` persists through the web-storage seam; `AnchorScope.envelope` sent on scoped open of a pinned anchor; during an edit turn the pinned view keeps rendering until the replacement node lands (no flash to original children).
- [ ] Implement; green; commit. (No new visual surface — skeleton and pill are existing UI; final look verified in-browser before the PR.)

## Phase 5 — verification + benchmarks

### Task 11: benchmark harness

**Files:** Create `scripts/remix-bench.mjs` (repo root, plain node; usage note in the header). Prereq: Task 9's Cadence policy update.

- [ ] Metrics are limited to what the route actually exposes, plus a browser probe — no new route contract:
  - from the UI message stream: send→first-stream-part, send→`data-ui` part, total stream bytes, tool part count/kind (model steps), JSON-parse failures (stream error parts), hunk-failure tool errors;
  - send→stage-rendered via a Playwright probe (stage iframe paints the new node);
  - provider input/output tokens from the Anthropic API response usage where surfaced, else recorded as n/a (documented limitation);
  - server hunk/validate/compile timings from the `FLOWLET_BENCH=1` log line (Task 6).
- [ ] Scenarios: first remix, follow-up pin edit, and a DETERMINISTIC failed-hunk retry (fixture request carrying a known-stale `baseHash`/`oldLines` mismatch — not a prompt hoping the model fails); small/medium/near-cap sources; warm caches, cold first-turn noted separately; N ≥ 10 varied asks for the hunk-failure/JSON-failure rates.
- [ ] Run on `main` (before) and this branch (after) against Cadence; results as tables in the PR body (raw JSON under `docs/superpowers/specs/assets/` if useful).
- [ ] Commit.

### Task 12: real-browser verification + PR

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint` across the workspace.
- [ ] In Cadence (`pnpm demo:accounting`), verify in a real browser: first remix via `edit_view` (fast path), follow-up edit on the pin, forced hunk-mismatch recovery, reset pill, and the no-baseline fallback (anchor without captured source behaves exactly as today). Screenshots of each.
- [ ] Update `docs/` where render_view/remix behavior is described (quickstart / package READMEs) — succinct.
- [ ] Open the PR (never merge): spec + plan links, before/after benchmark tables, screenshots, Codex-review provenance. Update the Orca worktree comment.

---

## Self-review notes (spec coverage)

Every spec section maps to a task: baseline→2/8, hunks→3, envelope+sealer→4/8, edit_view+materialization→6, prompt/nonce/adversarial→7, policy/agent incl. demo copies→9, shell/UX→10, JSON-repair (incl. `{}`-fallback replacement)→5, benchmarks→11, browser verification→12, threat-model assertions→4/7/8 tests. Deferred spec items have no tasks by design. Plan-review findings (2 Codex reviewers, both execute-with-changes) are incorporated: ResolvedRemixSource split, 6→8→7 ordering, remixSealer seam, MessageList pairing, demo policies, realistic benchmark contract, deterministic failed hunk.
