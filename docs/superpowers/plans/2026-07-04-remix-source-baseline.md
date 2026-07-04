# Source-Baseline Remixing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docs/superpowers/specs/2026-07-04-remix-source-baseline-design.md`: the remix baseline becomes the wrapped component's captured source (extractor step + server-side injection), with the DOM snapshot as automatic fallback.

**Architecture:** Contracts first (scoped-block `source`, `RemixSourceRecord`/`RemixSourceResolver`), then the engine prompt section (delimited untrusted-data block, edited-variant + mapping instructions), then `@flowlet/next` loading/enrichment, then the CLI extractor step, then Cadence wiring and browser fidelity verification. Stacks on PR #34; no shell changes at all.

**Tech stack:** Existing conventions: TypeScript, vitest, zod for the `.flowlet` schema. NOTE (Codex plan review): the existing extractor steps are regex/LLM-based — there is NO reusable AST/import-resolution substrate in `packages/flowlet-cli` today. Task 4 explicitly adds a parser dependency (TypeScript's own compiler API is already available transitively and needs no new install — prefer it; add `ts-morph` only if the bare API proves too painful) and updates `packages/flowlet-cli/package.json` accordingly.

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
- [ ] Dev-freshness tests: `NODE_ENV !== "production"` + mapped file exists on disk → enrichment uses the CURRENT file content (cap applied), not the captured `source`; production path never reads the filesystem at request time.
- [ ] Implement; green; commit.

### Task 4: CLI extractor — capture step

**Files:**
- Create: `packages/flowlet-cli/src/remix-sources.ts` + `remix-sources.test.ts`
- Modify: `packages/flowlet-cli/package.json` (parser dependency per the tech-stack note, if any is added)
- Modify: `packages/flowlet-cli/src/cli.ts` (+ `cli.test.ts`): the PRIMARY entry point is a NEW standalone command `flowlet remix-sources [dir]` (the CLI has only `init`/`publish` today — no existing re-run pattern), including help text. Capture is a per-build concern, not an install-time one: at init time the app has no wrappers yet.
- Modify: `packages/flowlet-cli/src/init.ts` and `next-wiring.ts` (+ tests): init WIRES the command into the app's `package.json` `prebuild` script (create or extend, idempotently) and runs it once (expected empty on fresh installs — the report says so rather than warning).

- [ ] Failing tests (fixture app trees): literal-id `<FlowletRemix id="x">` captured with resolved child component file, `sourceHash`, `capturedAt`; dynamic id skipped + reported; multi-child/non-component child captures the enclosing file; unresolvable import omitted + reported; server-only rule (`"use server"`, `server/`, `api/`, `pages/api/`, outside source root — enforced AFTER alias resolution) refused; 48 KB cap.
- [ ] Import-resolution fixtures MUST cover the real Next shapes: `@/*` tsconfig path aliases, extensionless imports, `index.ts` barrels, and relative paths — Cadence's own `@/components/dashboard/deadline-list` is the reference case.
- [ ] Implement deterministically (AST only, no LLM), fail-open per anchor with report entries; green; commit.
- [ ] Ground-truth check: run against demo-bank with one wrapped widget; commit the fixture expectations.

### Task 5: Cadence wiring

**Files:**
- Modify: `apps/demo-accounting/src/flowlet/chat-handler.ts` (or wherever its chat route builds agent input — confirm) to enrich scoped anchors for `upcoming-deadlines`.
- Source loading MUST be a raw file read on the server (`readFileSync` of `src/components/dashboard/deadline-list.tsx` relative to the app root, with the shared 48 KB cap/truncation helper) — NOT an import of the module: `deadline-list.tsx` is a client component whose import would not yield source text and could break the Node route (Codex plan review).

- [ ] Failing test: scoped send for `upcoming-deadlines` reaches the agent with `source` populated (file-read stubbed); other anchors untouched; missing file falls open to no enrichment.
- [ ] Implement; green; commit.

### Task 6: Full suite + browser fidelity verification

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` (demo-bank lint remains pre-existing-broken; everything else green).
- [ ] `pnpm demo:accounting`: run the SAME remix ask against the deadlines widget with source enrichment on, screenshot, and compare against the snapshot-only screenshots from PR #34. Both sets go in the PR body.

### Task 7: Codex diff review + PR

- [ ] Codex review of the full diff; triage (verify each finding against code); fix real ones; rerun affected tests.
- [ ] Push and open a PR based on `yousefh409/interface` (stacked on #34), spec/plan links + screenshots + session link. Do not merge.
