# Lane B: Activities + Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two new shelf pieces: `VendoActivities` (a drop-in feed of pending approvals + recent agent activity for host pages) and `VendoTrigger` (a button that opens the chat preloaded with a prompt), and prove both in the demos.

**Architecture:** Purely additive to `packages/ui` — new chrome files, new exports, one small registry module. Built on the existing `useApprovals` and `useActivity` hooks and the shipped `ApprovalCard`. Styling rides the `--vendo-*` token namespace like all chrome.

**Source of truth:** `docs/brainstorms/ui-usage-dx.md` (shelf decision §2). Read it first.

**Hard boundaries:** Do not modify existing chrome components except the single overlay-registration line noted in Task 2 (Lane A owns those files in parallel — keep your diff additive and expect to rebase on Lane A's merge; the export index and that one line are the only expected conflict points). Never commit to main; open a PR from this lane's branch.

---

### Task 1: `VendoActivities` — the combined feed

**Files:** create `packages/ui/src/chrome/vendo-activities.tsx`; export from `packages/ui/src/chrome/index.ts`; tests alongside existing chrome tests.

Decision (locked): ONE combined component, not separate approvals/activity drop-ins. Pending approvals render at the top as actionable `ApprovalCard`s (poll like demo-bank's MapleApprovals does today); the recent-activity feed (from `useActivity`) renders below, humanized like the ActivityPanel does. Quiet empty state (small "no recent agent activity" line — hosts place this in their own pages, an invisible component would confuse them). Configurable poll interval and activity item cap.

- [ ] TDD the approvals section: pending approvals render as decidable cards, decisions call through, section absent when queue is empty
- [ ] TDD the activity section: recent items render humanized, capped, empty state correct
- [ ] Accessibility: labeled section, keyboard decidable, AA contrast via tokens (same bar as existing chrome)
- [ ] Replace demo-bank's hand-rolled `MapleApprovals` with `VendoActivities` on the `/vendo` page; browser-verify an approval raised → decided in-place, plus the activity feed, with screenshots

### Task 2: Open-with-prompt registry

**Files:** create `packages/ui/src/chrome/overlay-open.ts` (mirror the `palette-hotkey.ts` global-registry pattern); one registration line inside the overlay.

- [ ] A module-level registry where a mounted `VendoOverlay` registers an "open, optionally with a prefilled prompt" handler; `openVendoConversation(prompt?)` opens the most recently mounted surface and seeds the composer with the prompt (prefilled, NOT auto-sent — the user presses send; this keeps Trigger safe on destructive prompts)
- [ ] Overlay registers on mount / unregisters on unmount (single-line edit to `vendo-overlay.tsx` — coordinate with Lane A, rebase expected)
- [ ] Fallback when nothing is registered: dev-mode console hint, no-op in production
- [ ] Tests for register/open/prefill/unregister lifecycle

### Task 3: `VendoTrigger`

**Files:** create `packages/ui/src/chrome/vendo-trigger.tsx`; export from chrome index.

- [ ] A button component: `prompt` (required), optional `context` string appended to the prompt, children as label; renders a token-styled button by default and supports rendering the host's own element as the trigger (follow the repo's existing composition idiom rather than inventing one)
- [ ] Activation calls `openVendoConversation(prompt)`
- [ ] Tests: renders, activates registry, keyboard accessible
- [ ] Add one real Trigger to demo-accounting (e.g. a "Nudge with AI" action near the missing-docs hero) and browser-verify the overlay opens prefilled; screenshots

### Task 4: Docs + finish

- [ ] Add both pieces to `docs/host-components.md` (one-sentence shelf descriptions per the brainstorm doc)
- [ ] Full gates green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
- [ ] PR with screenshots; signal `needs-review` then `triage-complete` via worktree comment
