# FlowletRemix + FlowletToasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two new shell surfaces from `docs/superpowers/specs/2026-07-04-flowlet-remix-and-toasts-design.md`: FlowletRemix (wrap a host component, remix it via the scoped overlay, pin per user) and FlowletToasts (in-app Channels surface for automation completions and approvals).

**Architecture:** Additive contracts first (RemixStore on the Store seam, structured automation payload on OutboundMessage), then embedded runtime impls and runner deliveries, then the shell surfaces, then FlowletRoot mounting, then the Cadence demo integration that doubles as browser verification. Toasts ride the existing Channels seam; no new seams.

**Tech stack:** Existing monorepo conventions: TypeScript, React, vitest (shell tests are component tests), pnpm + turbo. Spec is the source of truth for behavior; this plan is the build order. TDD each task: failing test, minimal impl, green, commit.

**Process rules:** Frequent small commits on this branch (`yousefh409/interface`). Every task ends green (`pnpm test --filter <pkg>` scoped is fine mid-stream; full suite in Task 11). If any task conflicts with the locked platform architecture, stop and surface it.

---

### Task 1: Contracts — RemixStore + OutboundMessage.automation

**Files:**
- Modify: `packages/flowlet-core/src/seams/store.ts`
- Modify: `packages/flowlet-core/src/seams/channels.ts`
- Test: `packages/flowlet-core/src/seams/seams.test.ts`

- [ ] Failing tests: RemixStore contract (pin upserts one record per principal+anchorId, get, unpin; store-assigned timestamps; record carries uiTree, originatingPrompt, components version map per spec) and OutboundMessage accepting the optional `automation` payload (`kind: completed | approval-required`, runId, optional stepId, summary).
- [ ] Implement: add `RemixRecord` + `RemixStore` interfaces and hang `remixes` off `Store`; extend `OutboundMessage` additively. Follow the existing sub-store authorship-rule doc comments.
- [ ] Green, then commit.

### Task 2: Embedded runtime impls

**Files:**
- Modify: `packages/flowlet-runtime/src/embedded/in-memory-store.ts` (+ its test)
- Modify: `packages/flowlet-runtime/src/embedded/in-app-channels.ts` (+ its test)

- [ ] Failing tests: in-memory RemixStore behavior (upsert/get/unpin per principal isolation); InAppChannels exposing a client subscription that receives structured `automation` payloads and preserves current plain-text behavior for messages without the payload.
- [ ] Implement both. The subscription is the client adapter seam FlowletToasts consumes.
- [ ] Green, commit.

### Task 3: Runner deliveries + idempotent resume

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/runner.ts` (+ `runner.test.ts`)

- [ ] Failing tests: a finished run (success or failure, scheduled or trigger-started) delivers one `completed` message via Channels with a human summary; a run pausing on approval delivers one `approval-required` with runId + stepId; resume is idempotent per (runId, stepId) — second resume is a no-op consistent with the existing DuplicateRunError pattern; resuming a run that is no longer waiting reports a stale outcome rather than throwing raw.
- [ ] Implement. Reuse the existing pause/resume machinery (`resumeTarget { stepId, approved }` in the interpreter); do not invent a parallel path.
- [ ] Green, commit.

### Task 4: Shell — DOM baseline snapshot module

**Files:**
- Create: `packages/flowlet-shell/src/remix/snapshot.ts`
- Test: `packages/flowlet-shell/src/remix/snapshot.test.ts`

- [ ] Failing tests encode the spec's snapshot contract exactly: includes tags/class/aria/role/visible text and table structure; excludes input values, hidden elements, data-*, inline handlers, script/style/iframe; max depth 12; 32 KB cap with a visible truncation marker.
- [ ] Implement as a pure DOM-in, string-out function (component-free, jsdom-testable).
- [ ] Green, commit.

### Task 5: Shell — PageContextRegistry

**Files:**
- Create: `packages/flowlet-shell/src/remix/page-context-registry.ts`
- Modify: `packages/flowlet-shell/src/context.tsx` (registry lives on the existing provider)
- Test: `packages/flowlet-shell/src/remix/page-context-registry.test.tsx`

- [ ] Failing tests: register on mount / deregister on unmount; duplicate id last-wins with one console warning; caps (32 anchors, 4 KB per-anchor context, 16 KB ambient total, drop-largest-first with warning); ambient summary excludes DOM snapshots.
- [ ] Implement registry + provider wiring, scoped per provider instance.
- [ ] Green, commit.

### Task 6: Shell — FlowletRemix wrapper, affordance, scoped overlay

**Files:**
- Create: `packages/flowlet-shell/src/remix/FlowletRemix.tsx`
- Modify: `packages/flowlet-shell/src/elements/FlowletOverlay.tsx` (scoped mode: anchor label header, opened-by-anchor state)
- Modify: `packages/flowlet-shell/src/FlowletThread.tsx` and `packages/flowlet-shell/src/use-flowlet-thread.ts` (anchor block rides outgoing message metadata when scoped)
- Modify: `packages/flowlet-shell/src/styles.css`, `packages/flowlet-shell/src/index.ts` (exports)
- Test: `packages/flowlet-shell/src/remix/FlowletRemix.test.tsx`

- [ ] Failing tests: renders children untouched by default; star affordance on hover/focus; clicking opens the overlay scoped (label in header); outgoing message carries the anchor block (anchorId, label, context, snapshot) only when scoped; plain Cmd+K open attaches ambient registry context and no snapshots; SSR renders children only.
- [ ] Implement. The overlay is the existing component with a scoped mode, not a fork.
- [ ] Green, commit. UI checkpoint: screenshot the affordance + scoped overlay in the showcase app for the PR.

### Task 7: Shell — remix candidate, Apply/Reset, pinned view

**Files:**
- Create: `packages/flowlet-shell/src/remix/pinned-view.tsx`
- Modify: `packages/flowlet-shell/src/remix/FlowletRemix.tsx`, `packages/flowlet-shell/src/FlowletThread.tsx`
- Test: `packages/flowlet-shell/src/remix/pinned-view.test.tsx`, extend `FlowletRemix.test.tsx`

- [ ] Failing tests: a generated view produced in a scoped conversation renders with an Apply action; Apply writes the pin via RemixStore and the anchor swaps to the pinned view with the "customized / reset" pill; Reset unpins and restores children; anchor `context` flows into the pinned view as validated host props and re-renders on change; sandbox error, validation failure, or components drift fail open to original children with the "customization unavailable, reset or retry" pill state; unscoped threads are byte-for-byte unaffected.
- [ ] Implement, reusing the existing uiTree render path and ENG-186 drift check (`component-drift.ts`).
- [ ] Green, commit.

### Task 8: Shell — FlowletToasts

**Files:**
- Create: `packages/flowlet-shell/src/toasts/toast-queue.ts` (pure policy state)
- Create: `packages/flowlet-shell/src/toasts/FlowletToasts.tsx`
- Modify: `packages/flowlet-shell/src/styles.css`, `packages/flowlet-shell/src/index.ts`
- Test: `packages/flowlet-shell/src/toasts/toast-queue.test.ts`, `packages/flowlet-shell/src/toasts/FlowletToasts.test.tsx`

- [ ] Failing tests, policy first (pure): max 2 visible with FIFO queue; suppression while a conversation is active; ~8s auto-dismiss except approvals; while-you-were-away collapse from a last-seen cursor; approval Approve triggers the resume bridge once (idempotent), flips to stale state when the run is no longer waiting, error state links to the run.
- [ ] Component tests: renders from the InAppChannels client subscription; approval and completed variants; dismiss.
- [ ] Implement queue then component. Cursor in localStorage per spec.
- [ ] Green, commit. UI checkpoint: screenshot both toast variants.

### Task 9: FlowletRoot mounts toasts

**Files:**
- Modify: `packages/flowlet-next/src/client/flowlet-root.tsx` (+ `flowlet-root.test.tsx`)

- [ ] Failing tests: FlowletRoot mounts FlowletToasts by default; `toasts={false}` opts out; placement knob forwarded.
- [ ] Implement, green, commit.

### Task 10: Cadence demo integration (verification vehicle)

**Files:**
- Modify: the Cadence dashboard widget chosen as the remix target (`apps/demo-accounting/src/components/dashboard/deadline-list.tsx` or the closest data widget — confirm in-repo) wrapped in `FlowletRemix` with real context data.
- Modify: Cadence flowlet wiring as needed so a demo automation run produces both toast variants (`apps/demo-accounting/src/flowlet/`, `apps/demo-accounting/src/components/flowlet/`).

- [ ] Wrap the widget; verify default rendering is pixel-identical before anything else.
- [ ] Wire the demo beat: run an automation that completes (completion toast) and one that pauses on approval (approval toast).
- [ ] Commit.

### Task 11: Full suite green

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` at the root; fix regressions. Commit any fixes.

### Task 12: Real-browser verification + screenshots

- [ ] `pnpm demo:accounting`; drive the full remix beat in a real browser: hover affordance, scoped overlay ask, generated candidate, Apply, pill, reload persistence, Reset. Fire the automation beat for both toasts, including while-you-were-away on reload.
- [ ] Capture screenshots of: affordance, scoped overlay, remix candidate with Apply, pinned view with pill, completion toast, approval toast. These go in the PR body.

### Task 13: Code review + PR

- [ ] Codex review of the full diff; triage findings (verify each against code before accepting); fix real ones; rerun affected tests.
- [ ] Open PR to `main` with spec/plan links, screenshots, and the session link. Do not merge (Yousef merges).
