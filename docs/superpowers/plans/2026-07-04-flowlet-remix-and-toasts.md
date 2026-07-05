# FlowletRemix + FlowletToasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two new shell surfaces from `docs/superpowers/specs/2026-07-04-flowlet-remix-and-toasts-design.md`: FlowletRemix (wrap a host component, remix it via the scoped overlay, pin per user) and FlowletToasts (in-app Channels surface for automation completions and approvals).

**Architecture:** Additive contracts first (RemixStore on the Store seam, structured automation payload on OutboundMessage, anchor block on the chat protocol), then embedded runtime impls and runner deliveries, then the client plumbing that Codex review flagged as the real work (`@flowlet/next` routes + shell client seams), then the shell surfaces, then FlowletRoot mounting and the Cadence demo integration that doubles as browser verification. Toasts ride the existing Channels seam; no new seams.

**Tech stack:** Existing monorepo conventions: TypeScript, React, vitest (shell tests are component tests), pnpm + turbo. Spec is the source of truth for behavior; this plan is the build order. TDD each task: failing test, minimal impl, green, commit.

**Process rules:** Frequent small commits on this branch (`yousefh409/interface`). Every task ends green (package-scoped test runs are fine mid-stream; full suite in Task 12). If any task conflicts with the locked platform architecture, stop and surface it.

**Plan-review provenance:** Codex plan review found 3 blockers (no client delivery path for toasts, no client access to RemixStore, anchor metadata not on any model-visible path) and 3 majors (Cadence provider boundary, pinned-view context validation, non-success terminal outcomes). All folded in below; the `skipped` outcome stays silent by spec decision.

---

### Task 1: Contracts — RemixStore, OutboundMessage.automation, anchor protocol block

**Files:**
- Modify: `packages/flowlet-core/src/seams/store.ts`
- Modify: `packages/flowlet-core/src/seams/channels.ts`
- Modify: `packages/flowlet-core/src/protocol.ts` (anchor block on chat metadata)
- Test: `packages/flowlet-core/src/seams/seams.test.ts` and the protocol test neighbors

- [ ] Failing tests: RemixStore contract (pin upserts one record per principal+anchorId, get, unpin; store-assigned timestamps; record carries uiTree, originatingPrompt, components version map per spec); OutboundMessage accepting the optional `automation` payload (`kind: completed | approval-required`, runId, optional stepId, summary); chat metadata accepting an optional anchor block (scoped anchor: id, label, context, snapshot; ambient anchors: id, label, context only).
- [ ] Implement: `RemixRecord` + `RemixStore` hung off `Store` as `remixes`; extend `OutboundMessage` and `FlowletMetadata` additively. Follow the existing sub-store authorship-rule doc comments.
- [ ] Green, then commit.

### Task 2: Embedded runtime impls

**Files:**
- Modify: `packages/flowlet-runtime/src/embedded/in-memory-store.ts` (+ its test)
- Modify: `packages/flowlet-runtime/src/embedded/in-app-channels.ts` (+ its test)

- [ ] Failing tests: in-memory RemixStore behavior (upsert/get/unpin, per-principal isolation); InAppChannels retains deliveries with monotonic cursor ids and exposes list-since-cursor reads (the transport Task 4 polls), preserving current behavior for messages without the payload.
- [ ] Implement both.
- [ ] Green, commit.

### Task 3: Runner deliveries + idempotent resume

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/runner.ts` (+ `runner.test.ts`)

- [ ] Failing tests: exactly one `completed` delivery per terminal run for `succeeded`, `failed`, and `cancelled` — including the cap path outside `finalize()`; guard-false `skipped` runs deliver nothing (spec decision); a run pausing on approval delivers one `approval-required` with runId + stepId; resume is idempotent per (runId, stepId) consistent with the existing DuplicateRunError pattern; resuming a run that is no longer waiting reports a stale outcome rather than throwing raw.
- [ ] Implement. Reuse the existing pause/resume machinery (`resumeTarget { stepId, approved }`); do not invent a parallel path.
- [ ] Green, commit.

### Task 4: Client plumbing — @flowlet/next routes + shell client seams (Codex blockers 1–3)

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/chat.ts` (+ tests): forward the anchor block from chat metadata into model-visible context; add routes for remix pin/get/unpin (backed by core `Store.remixes` + resolved principal), deliveries-since-cursor, and approval resume (runId, stepId, approved).
- Modify: `packages/flowlet-runtime/src/render-view-tool.ts` (+ test): when the request is anchor-scoped, tag the emitted `data-ui` as a remix candidate for that anchorId.
- Modify: `packages/flowlet-shell/src/seams/store.ts` and `packages/flowlet-shell/src/context.tsx` (+ tests): shell-side client seams — a remix client (pin/get/unpin) and a notifications client (poll deliveries, resume approval) provided via `FlowletShellProvider`, following the existing shell `FlowletStore` client-seam pattern.
- Modify: `packages/flowlet-next/src/client/flowlet-root.tsx` (+ test): construct fetch-backed impls of both clients and hand them to the provider.

- [ ] Failing tests per file, in the order above (server routes, tagging, shell seams, root wiring).
- [ ] Implement. Polling transport v1 (interval + on-focus); no websockets.
- [ ] Green, commit.

### Task 5: Shell — DOM baseline snapshot module

**Files:**
- Create: `packages/flowlet-shell/src/remix/snapshot.ts`
- Test: `packages/flowlet-shell/src/remix/snapshot.test.ts`

- [ ] Failing tests encode the spec's snapshot contract exactly: includes tags/class/aria/role/visible text and table structure; excludes input values, hidden elements, data-*, inline handlers, script/style/iframe; max depth 12; 32 KB cap with a visible truncation marker.
- [ ] Implement as a pure DOM-in, string-out function (component-free, jsdom-testable).
- [ ] Green, commit.

### Task 6: Shell — PageContextRegistry

**Files:**
- Create: `packages/flowlet-shell/src/remix/page-context-registry.ts`
- Modify: `packages/flowlet-shell/src/context.tsx`
- Test: `packages/flowlet-shell/src/remix/page-context-registry.test.tsx`

- [ ] Failing tests: register on mount / deregister on unmount; duplicate id last-wins with one console warning; caps (32 anchors, 4 KB per-anchor context, 16 KB ambient total, drop-largest-first with warning); ambient summary excludes DOM snapshots.
- [ ] Implement registry + provider wiring, scoped per provider instance.
- [ ] Green, commit.

### Task 7: Shell — FlowletRemix wrapper, affordance, scoped overlay

**Files:**
- Create: `packages/flowlet-shell/src/remix/FlowletRemix.tsx`
- Modify: `packages/flowlet-shell/src/elements/FlowletOverlay.tsx` (scoped mode: anchor label header, opened-by-anchor state)
- Modify: `packages/flowlet-shell/src/FlowletThread.tsx` and `packages/flowlet-shell/src/use-flowlet-thread.ts` (attach the Task 1 anchor block to outgoing messages when scoped; ambient block on plain opens)
- Modify: `packages/flowlet-shell/src/styles.css`, `packages/flowlet-shell/src/index.ts` (exports)
- Test: `packages/flowlet-shell/src/remix/FlowletRemix.test.tsx`

- [ ] Failing tests: renders children untouched by default; star affordance on hover/focus; clicking opens the overlay scoped (label in header); outgoing message carries the anchor block (with snapshot) only when scoped; plain Cmd+K attaches ambient registry context and no snapshots; SSR renders children only.
- [ ] Implement. The overlay is the existing component with a scoped mode, not a fork.
- [ ] Green, commit. UI checkpoint: screenshot the affordance + scoped overlay for the PR.

### Task 8: Shell — remix candidate, Apply/Reset, pinned view

**Files:**
- Create: `packages/flowlet-shell/src/remix/pinned-view.tsx`
- Modify: `packages/flowlet-shell/src/remix/FlowletRemix.tsx`, `packages/flowlet-shell/src/FlowletThread.tsx`
- Test: `packages/flowlet-shell/src/remix/pinned-view.test.tsx`, extend `FlowletRemix.test.tsx`

- [ ] Failing tests: a remix-candidate-tagged view renders with an Apply action in scoped threads; Apply patches current anchor context into the payload data, validates the patched payload, and only then pins via the remix client; the anchor swaps to the pinned view with the "customized / reset" pill; Reset unpins and restores children; anchor `context` changes re-render the pinned view (patched the same way) and validation failure at any point fails open to original children with the "customization unavailable, reset or retry" pill state; components drift (ENG-186 `component-drift.ts`) also fails open; unscoped threads are byte-for-byte unaffected.
- [ ] Implement, reusing the existing uiTree render path.
- [ ] Green, commit.

### Task 9: Shell — FlowletToasts

**Files:**
- Create: `packages/flowlet-shell/src/toasts/toast-queue.ts` (pure policy state)
- Create: `packages/flowlet-shell/src/toasts/FlowletToasts.tsx`
- Modify: `packages/flowlet-shell/src/styles.css`, `packages/flowlet-shell/src/index.ts`
- Test: `packages/flowlet-shell/src/toasts/toast-queue.test.ts`, `packages/flowlet-shell/src/toasts/FlowletToasts.test.tsx`

- [ ] Failing tests, policy first (pure): max 2 visible with FIFO queue; suppression while a conversation is active; ~8s auto-dismiss except approvals; while-you-were-away collapse from the last-seen cursor; approval Approve calls the notifications client resume exactly once, flips to stale state when the run is no longer waiting, error state links to the run.
- [ ] Component tests: renders from the notifications client polling; approval and completed variants; dismiss.
- [ ] Implement queue then component. Cursor in localStorage per spec.
- [ ] Green, commit. UI checkpoint: screenshot both toast variants.

### Task 10: FlowletRoot mounts toasts

**Files:**
- Modify: `packages/flowlet-next/src/client/flowlet-root.tsx` (+ `flowlet-root.test.tsx`)

- [ ] Failing tests: FlowletRoot mounts FlowletToasts by default; `toasts={false}` opts out; placement knob forwarded.
- [ ] Implement, green, commit.

### Task 11: Cadence demo integration (verification vehicle)

**Files:**
- Modify: `apps/demo-accounting/src/app/layout.tsx` and `apps/demo-accounting/src/components/flowlet/FlowletLayer.tsx`: one client `FlowletRoot`/provider must wrap BOTH the app content and the overlay layer (Codex major 4: today `AppShell` and `FlowletLayer` are siblings, so a wrapped widget could not reach the registry or overlay). Verify existing surfaces still work after the move.
- Modify: `apps/demo-accounting/src/components/dashboard/deadline-list.tsx` (or the closest data widget confirmed in-repo): wrap in `FlowletRemix` with real context data.
- Modify: Cadence flowlet wiring as needed so a demo automation run produces both toast variants (`apps/demo-accounting/src/flowlet/`).

- [ ] Restructure providers; verify default rendering and existing beats are unchanged.
- [ ] Wrap the widget; verify default rendering is pixel-identical.
- [ ] Wire the demo beat: one automation that completes (completion toast) and one that pauses on approval (approval toast).
- [ ] Commit.

### Task 12: Full suite green

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` at the root; fix regressions. Commit any fixes.

### Task 13: Real-browser verification + screenshots

- [ ] `pnpm demo:accounting`; drive the full remix beat in a real browser: hover affordance, scoped overlay ask, generated candidate, Apply, pill, reload persistence, Reset. Fire the automation beat for both toasts, including while-you-were-away on reload.
- [ ] Capture screenshots of: affordance, scoped overlay, remix candidate with Apply, pinned view with pill, completion toast, approval toast. These go in the PR body.

### Task 14: Code review + PR

- [ ] Codex review of the full diff; triage findings (verify each against code before accepting); fix real ones; rerun affected tests.
- [ ] Open PR to `main` with spec/plan links, screenshots, and the session link. Do not merge (Yousef merges).
