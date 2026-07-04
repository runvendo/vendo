# Source-Baseline Remixing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docs/superpowers/specs/2026-07-04-remix-source-baseline-design.md`: the remix baseline becomes the wrapped component's captured source (extractor step + server-side injection), with the DOM snapshot as automatic fallback.

**Architecture:** Contracts first (scoped-block `source`, `RemixSourceRecord`/`RemixSourceResolver`), then the engine prompt section (delimited untrusted-data block, edited-variant + mapping instructions), then `@flowlet/next` loading/enrichment, then the CLI extractor step, then Cadence wiring and browser fidelity verification. Stacks on PR #34; no shell changes at all.

**Tech stack:** Existing conventions: TypeScript, vitest, zod for the `.flowlet` schema, ts-morph/AST utilities already used by the ENG-197 extractor (match whatever `packages/flowlet-cli` uses today — confirm in-repo before Task 4).

**Process rules:** TDD per task (failing test → minimal impl → green → commit) on branch `yousefh409/remix-source-baseline`. Full suite in Task 6. Stop and surface if anything conflicts with the locked architecture.

---

### Task 1: Contracts — scoped source + shared record types

**Files:**
- Modify: `packages/flowlet-core/src/protocol.ts` (scoped block only: `AnchorContextBlock.scoped` gains `source?: string`; export `RemixSourceRecord`, `RemixSourceResolver`)
- Test: `packages/flowlet-core/src/protocol.test.ts`

- [ ] Failing tests: scoped block accepts `source`; `AnchorRef` (ambient) has no such field (type-level assertion); `RemixSourceRecord` requires file/source/sourceHash/capturedAt.
- [ ] Implement additively; green; commit.

### Task 2: Engine — source section with injection isolation

**Files:**
- Modify: `packages/flowlet-runtime/src/engine.ts` (`anchorSection`)
- Test: `packages/flowlet-runtime/src/engine.test.ts`

- [ ] Failing tests: scoped anchor WITH `source` → prompt contains the delimited untrusted-data block, the captured-snapshot framing, edited-variant instruction, mapping rules, and the non-disclosure nudge; WITHOUT `source` → prompt byte-identical to today; adversarial test: source whose comments say "ignore previous instructions" still lands inside the delimited data block with the data-only framing present.
- [ ] Implement (48 KB cap with visible truncation marker applied here as the last defense even though capture also caps); green; commit.

### Task 3: @flowlet/next — load + enrich

**Files:**
- Modify: `packages/flowlet-next/src/flowlet-dir.ts` (+ test): read `remix-sources.json`; absent → empty map; present-invalid → fail loud via zod (same rule as theme/tools).
- Modify: `packages/flowlet-next/src/options.ts` (+ test): `remixSources?: Record<string, string> | RemixSourceResolver`.
- Modify: `packages/flowlet-next/src/chat.ts` and `packages/flowlet-next/src/handler.ts` (+ tests): strip client-supplied `scoped.source`, then enrich the last user message's scoped block; precedence option-first, fall through to the file map.

- [ ] Failing tests: absent file → no enrichment; valid file → enrichment by anchorId; invalid file → boot error; client-supplied source is stripped even when no server source exists; option resolver wins over file map, `undefined` falls through.
- [ ] Implement; green; commit.

### Task 4: CLI extractor — capture step

**Files:**
- Create: `packages/flowlet-cli/src/remix-sources.ts` + `remix-sources.test.ts`
- Modify: `packages/flowlet-cli/src/init.ts` (+ test) to run the step and include results in the extraction report; wire a standalone re-run path the way existing steps expose one (confirm the existing command structure in `cli.ts` first and follow it).

- [ ] Failing tests (fixture app trees): literal-id `<FlowletRemix id="x">` captured with resolved child component file, `sourceHash`, `capturedAt`; dynamic id skipped + reported; multi-child/non-component child captures the enclosing file; unresolvable import omitted + reported; server-only rule (`"use server"`, `server/`, `api/`, `pages/api/`, outside source root) refused; 48 KB cap.
- [ ] Implement deterministically (AST only, no LLM), fail-open per anchor with report entries; green; commit.
- [ ] Ground-truth check: run against demo-bank with one wrapped widget; commit the fixture expectations.

### Task 5: Cadence wiring

**Files:**
- Modify: `apps/demo-accounting/src/flowlet/chat-handler.ts` (or wherever its chat route builds agent input — confirm) to enrich scoped anchors from a hand-passed map containing `upcoming-deadlines` → the DeadlineList source (+ test following the existing chat-handler tests).

- [ ] Failing test: scoped send for `upcoming-deadlines` reaches the agent with `source` populated; other anchors untouched.
- [ ] Implement; green; commit.

### Task 6: Full suite + browser fidelity verification

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` (demo-bank lint remains pre-existing-broken; everything else green).
- [ ] `pnpm demo:accounting`: run the SAME remix ask against the deadlines widget with source enrichment on, screenshot, and compare against the snapshot-only screenshots from PR #34. Both sets go in the PR body.

### Task 7: Codex diff review + PR

- [ ] Codex review of the full diff; triage (verify each finding against code); fix real ones; rerun affected tests.
- [ ] Push and open a PR based on `yousefh409/interface` (stacked on #34), spec/plan links + screenshots + session link. Do not merge.
