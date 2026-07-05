# Context Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared prompt core and the four voice-quality features from
`docs/superpowers/specs/2026-07-04-context-engineering-design.md` (v2, post-Codex), so chat
and voice run on one rule source and voice reaches chat's context quality.

**Architecture:** A pure prompt module in `@flowlet/core` feeds three migrated consumers
(demo-bank chat, demo-bank voice, `@flowlet/next` default). Truncation becomes an isomorphic
core helper applied at all four tool-result ingestion points. Voice display tools gain a
source declaration that the client turns into data-bound refreshable payloads backed by a
read-only replay registry. The shell assembles a structured session brief for voice start.

**Tech stack:** TypeScript monorepo (pnpm + turbo), vitest, existing packages only — no new
dependencies.

**Ground rules for the executor:** TDD every task (failing test → minimal code → green →
commit). Never commit on main — stay on `yousefh409/context-engineering`. Run
`pnpm typecheck && pnpm test` at every phase boundary. Per repo rule, voice/UI behavior is
additionally verified in a real browser with screenshots for the PR. This plan is
deliberately high-level: it fixes goals, boundaries, file placement, and order; the executor
writes the code against the spec.

---

## Phase 0 — Freeze the baseline (must land before any prompt change)

### Task 0.1: Snapshot the pre-migration prompts as fixtures

**Files:**
- Create: `apps/demo-bank/src/flowlet/__fixtures__/chat-instructions.baseline.txt`
- Create: `packages/flowlet-next/src/__fixtures__/default-instructions.baseline.txt`
- Test: `apps/demo-bank/src/flowlet/agent.test.ts` (extend), `packages/flowlet-next/src/agent.test.ts` (extend)

- [ ] Write a test that renders today's `buildInstructions()` (demo-bank) with normalized
      dynamic inputs (stable component catalogs, stable brand tokens) and asserts it equals
      the checked-in baseline fixture; same for `@flowlet/next`'s default prompt.
- [ ] Generate the two fixtures from current code; tests green.
- [ ] Commit. These fixtures are the diff anchor for the migration tasks (spec: the test must
      not compare the new path to itself).

## Phase 1 — Prompt core in `@flowlet/core`

### Task 1.1: Section builders

**Files:**
- Create: `packages/flowlet-core/src/prompt/sections.ts` (+ `sections.test.ts`)
- Create: `packages/flowlet-core/src/prompt/index.ts`; export from `packages/flowlet-core/src/index.ts`

- [ ] Test-drive each builder from spec §1/§2/§6/§7/§8: `genuiFormatSection`,
      `showVsSaySection(modality)`, `refreshableViewsSection(modality)`,
      `connectSection(modality)`, `consentSection(modality)`, `styleSection(norms)`,
      `registerSection(modality)`, `capabilitiesSection(modality, toolSummary)`,
      `proactivitySection(modality)`, `guardrailSection(modality)`.
- [ ] Content comes from the spec's approved wording (chat show-vs-say/genui text lifted from
      today's demo-bank prompt so Phase 3 diffs stay near-nil; voice variants are the new
      spec blocks, including anti-yap and Connect/approval-card wording).
- [ ] Tests assert: both modality variants render, pure functions (no imports beyond core),
      no host-flavored strings in any platform output.
- [ ] Commit.

### Task 1.2: Consent string catalog

**Files:**
- Create: `packages/flowlet-core/src/prompt/consent-strings.ts` (+ test)

- [ ] Centralize ALL voice consent copy as named builders (spec §1): driver protocol
      paragraph, `resolve_pending_approval` tool description, pending-action note templates
      (act/critical), screen-only rejection copy. Text lifted verbatim from today's
      `packages/flowlet-shell/src/voice/realtime-driver.ts` so behavior is unchanged.
- [ ] Commit.

### Task 1.3: Assemblers with guarded order

**Files:**
- Create: `packages/flowlet-core/src/prompt/assemblers.ts` (+ test)

- [ ] `buildChatInstructions({ identity, brandGuidance, catalogs, capabilities, toolSummary, extras })`
      and `buildVoiceInstructions({ persona, toolSummary, extras })`.
- [ ] Tests assert the spec's assembly order: platform sections → typed host slots →
      free-form extras → `guardrailSection` last; extras can never appear after guardrails.
- [ ] Commit.

### Task 1.4: Capability summary generator

**Files:**
- Create: `packages/flowlet-core/src/prompt/capability-summary.ts` (+ test)

- [ ] A pure function from a list of tool descriptors ({name, description, tier/annotations,
      toolkit}) to the compact user-terms summary in spec §7, including the
      connectable-but-unconnected toolkit list (passed in as a parameter).
- [ ] Commit.

## Phase 2 — Truncation (`capToolOutput`)

### Task 2.1: The core helper

**Files:**
- Create: `packages/flowlet-core/src/prompt/cap-tool-output.ts` (+ test)

- [ ] Test-drive against Gmail-shaped fixtures (huge HTML body, base64 attachment, long
      arrays) and the spec's shape-stability properties: same-shaped output, markers only
      inside truncated strings plus one reserved root-level note, arrays capped without
      fabricated rows, deterministic, per-call budget parameter.
- [ ] Commit.

### Task 2.2: Apply at all four ingestion points

**Files:**
- Modify: `packages/flowlet-runtime/src/engine.ts` (Composio tool wrapping)
- Modify: `apps/demo-bank/src/app/api/flowlet/voice/tools/route.ts` (bridge, incl. replay)
- Modify: `packages/flowlet-react/src/provider.tsx` (host-tool runner)
- Modify: `packages/flowlet-shell/src/voice/realtime-driver.ts` (before results enter the realtime session)

- [ ] One test per point proving oversized results are capped and normal results pass
      through byte-identical. Voice budgets tighter than chat (constants live next to each
      call site; spec leaves exact numbers as implementation-time tunables).
- [ ] Commit per ingestion point.

## Phase 3 — Migrate the three prompt consumers

### Task 3.1: Per-run instruction assembly in the engine

**Files:**
- Modify: `packages/flowlet-runtime/src/engine.ts` (+ test)

- [ ] `createFlowletAgent` accepts `instructions: string | ((ctx: { toolSummary }) => string)`,
      evaluated inside `run()` after Composio ingestion, where `toolSummary` describes the
      actual merged toolset. Backwards compatible: plain strings behave exactly as today.
- [ ] Commit.

### Task 3.2: demo-bank chat migration

**Files:**
- Modify: `apps/demo-bank/src/flowlet/agent.ts` (+ existing test file)

- [ ] Recompose `buildInstructions()` onto `buildChatInstructions`: platform sections from
      core; Maple identity/capabilities narrative/automations/cents-to-dollars as host slots
      and extras; brand guidance composed in as today; capability summary via Task 3.1's ctx.
- [ ] Diff test against the Phase 0 fixture: enumerated intended hunks only (new register /
      capabilities / proactivity / guardrail sections, section ordering), everything else
      identical.
- [ ] Commit.

### Task 3.3: `@flowlet/next` default prompt migration

**Files:**
- Modify: `packages/flowlet-next/src/agent.ts` (+ test, Phase 0 fixture diff)

- [ ] Same recomposition for the handler's default prompt; product name stays an option.
- [ ] Commit.

### Task 3.4: demo-bank voice migration

**Files:**
- Modify: `apps/demo-bank/src/components/flowlet/voice-realtime.ts`
- Modify: `packages/flowlet-shell/src/voice/realtime-driver.ts` (+ tests both)

- [ ] `INSTRUCTIONS` recomposes onto `buildVoiceInstructions` (Maple persona +
      cents-to-dollars as host content; `toolSummary` derived from the composed
      `VoiceToolDef` list). Driver's `protocolInstructions()` and approval-flow strings now
      import from `consent-strings.ts`; enforcement logic untouched.
- [ ] Commit.

## Phase 4 — Refreshable voice views

### Task 4.1: Read-only replay registry

**Files:**
- Create: `packages/flowlet-shell/src/voice/replay-registry.ts` (+ test)
- Modify: `apps/demo-bank/src/components/flowlet/run-query.ts` (+ test) to consult it

- [ ] A client-side registry mapping tool name → replay executor for read-tier tools:
      host tools via `executeHostToolCall`, integration tools via the voice bridge
      (capped identically per Task 2.2). Reopen's query runner tries the registry before its
      existing server-action path; unknown tools keep today's behavior.
- [ ] Commit.

### Task 4.2: Source declaration + data-bound payloads

**Files:**
- Modify: `apps/demo-bank/src/components/flowlet/voice-realtime.ts` (+ test)

- [ ] `show_table`/`show_key_value` gain optional `source: { tool, input, rowsPath }`.
      A per-session result cache records read-tool results. On a valid match (rowsPath
      resolves to an array of records covering the declared column keys, tool is in the
      replay registry), `toView` emits the data-bound payload from spec §3: capped result
      verbatim in `data`, rows prop bound with `$path`, `queries` declared. Any failure →
      today's snapshot.
- [ ] Voice prompt already instructs honest declaration (Task 1.1's
      `refreshableViewsSection('voice')`).
- [ ] Commit.

### Task 4.3: Live browser verification

- [ ] `pnpm demo`; by voice: build a transactions table, pin it, mutate data (new
      transaction via the app), reopen the saved view → fresh data. Screenshot before/after
      for the PR. If realtime voice is unavailable in the environment, verify the same path
      by invoking the display-tool handlers directly in the browser console and reopening;
      note whichever method was used in the PR.

## Phase 5 — Session brief + open_saved_flowlet

### Task 5.1: `voiceSessionBrief()`

**Files:**
- Create: `packages/flowlet-shell/src/voice/session-brief.ts` (+ test)
- Modify: `packages/flowlet-shell/src/FlowletThread.tsx` (replace the inline tail builder)

- [ ] Four capped blocks from spec §4, sources exactly as specified: text parts;
      `data-ui` parts (title/kind/row count, provenance from payload `queries`);
      opportunistic tool-part digests; `flows` names + stable ids. Per-block caps + total
      budget as constants; renders to text into `VoiceSessionInit.context`.
- [ ] Commit.

### Task 5.2: `open_saved_flowlet` voice tool

**Files:**
- Modify: `packages/flowlet-shell/src/FlowletThread.tsx`, `packages/flowlet-shell/src/voice/voice-session.ts` as needed (+ tests)

- [ ] A shell-contributed read-tier voice tool taking a saved-flowlet id (from the brief)
      and firing the same `onOpenFlow` callback the gallery uses. Companion prompt sentence
      ships in `refreshableViewsSection`/brief guidance from Task 1.1.
- [ ] Commit.

### Task 5.3: Live browser verification

- [ ] Mid-thread voice start: chat about transactions with a table on screen, start voice,
      ask "which of those is the biggest?" → answered from context without re-fetch;
      "open my <saved view name>" → opens. Screenshots for the PR.

## Phase 6 — Ship

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint` — all green.
- [ ] Fresh read of the spec against the diff: every section implemented or explicitly
      deferred with a note.
- [ ] Update `docs/` where behavior changed (quickstart/host docs mention the new
      assembler options and truncation).
- [ ] Open PR to `main` (never merge): summary, spec + plan links, screenshots from Tasks
      4.3/5.3, enumerated prompt-diff hunks from Phase 3.

## Task order & dependencies

Phases are sequential (0 → 6). Within phases: 1.1 → 1.2/1.3/1.4 (parallel-safe after 1.1);
2.1 before 2.2; 3.1 before 3.2; 4.1 before 4.2. Session brief (5.x) is independent of
Phase 4 except for shared prompt sentences from 1.1.

## Out of scope (from spec)

End-user custom instructions; LLM summarization; ENG-189/190 memory; consent enforcement
changes.
