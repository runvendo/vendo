# F10 — Overlay thread history + resumption (ENG-388, pack 6)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development.
> Executed inline (single cohesive UI feature; executing-plans).

**Goal:** The default overlay survives a page reload (resumes the last
conversation) and gains a header icon — beside expand / new chat / close —
that opens a previous-conversations picker (select to resume, cancel to stay).

**Architecture:** All the resume machinery exists: `VendoThreadProps.threadId`
+ `useVendoThread` load history, self-heal stale/foreign ids to a fresh
thread, and resume mid-stream. `VendoOverlay` simply never forwards a
threadId. We add (1) an origin-scoped last-thread store following the
discoverability-store pattern, (2) a `resumeThreadId` state feeding the
Thread's `threadId` prop and key, (3) an internal `HistoryPicker` card fed by
`useThreads` (title + updatedAt, principal-scoped wire). No new public
exports (picker stays internal → no export-surface / eject changes; the
overlay is not ejectable).

**Tech stack:** packages/ui chrome (React, jsdom vitest + `test/wire-server.ts`).

## Global constraints

- Icon pattern: 15×15 inline SVG, `stroke="currentColor"`, `strokeWidth=2`,
  `aria-hidden`, + `.fl-sr-only` span; button `type="button"` + `aria-label`.
- Header offset ladder (28px + 6px gap): desktop close 12 → new 46 → expand
  80 → **history 114**. Coarse-pointer (44px): 12 → 62 → 112 → **162**.
  Takeover (expand absent): close 12+safe → new 46+safe → **history 80+safe**;
  takeover+coarse: 4 → 54 → **104** (+safe).
- Storage: `vendo:last-thread` key; SSR/throw-safe accessor; reads in
  effects/handlers, never during render (hydration convention).
- Copy: consumer-voice law sweeps text + aria-labels; use "conversation(s)"
  (existing vocabulary), never "chat".
- The Thread key must NOT change when `onThreadId` adopts a minted id
  (mid-conversation remount = data loss). `resumeThreadId` changes only via
  mount-restore, picker selection, and new-conversation clearing.

## Tasks

### 1. `last-thread.ts` store (+ SSR test)
Files: `packages/ui/src/chrome/last-thread.ts`,
`packages/ui/test/chrome/last-thread-ssr.test.ts` (node env, per
`discoverability-store-ssr.test.ts`).
API: `lastThreadId(): string | undefined` (validates `/^thr_.+$/`),
`rememberThread(id)`, `forgetThread()`. Best-effort try/catch, `storage()`
null on SSR/denied. Test: inert without `window`.

### 2. Resume-on-mount + persistence in `VendoOverlay`
Files: `packages/ui/src/chrome/vendo-overlay.tsx`,
`packages/ui/test/chrome/overlay-history.test.tsx` (new, wire-server backed).
- `resumeThreadId` state; mount effect reads `lastThreadId()`.
- Thread key gains `:${resumeThreadId ?? "new"}`; `threadId` prop forwarded
  when set; `onThreadId` also calls `rememberThread` (verify it fires for
  supplied ids too — if not, remember at selection/restore sites).
- `newConversation` and external `conversationKey` bumps clear
  `resumeThreadId` + `forgetThread()`.
Tests: send → minted id persisted; pre-seeded `thr_1` → messages render
after reload-mount; stale `thr_gone` → fresh landing, no crash; new
conversation → key cleared.

### 3. History header icon + picker card
Files: `packages/ui/src/chrome/history-picker.tsx` (internal, NOT exported),
`vendo-overlay.tsx`, `chrome-css.ts`, same test file.
- Button `.fl-overlay-close.fl-overlay-history`, aria-label "Previous
  conversations", `aria-expanded`, history SVG; rendered in takeover too.
- Card `.fl-history` (absolute, under header, themed, scrollable):
  `useThreads` on open-mount only; rows = title + updatedAt date, filtered
  to exclude the active thread (`panelThreadId ?? resumeThreadId`); empty
  state "No previous conversations yet."; error state; Cancel X. Escape
  inside the card stops propagation, closes the card, refocuses the button.
- Selection: close card, set `resumeThreadId`, focus composer.
Tests: button present; open lists `thr_1`; select → its messages render;
cancel/Escape → landing intact; active thread filtered out.

### 4. CSS ladder + gates + docs + changeset
- `chrome-css.ts`: the four `.fl-overlay-history` offsets + card styles.
- Full gates: ui tests, build (eject assembly), typecheck, lint,
  consumer-voice sweep.
- Docs: docs-site overlay docs (quickstart "Tune the overlay" mention +
  ui/components section) — conversations persist across reloads; the
  history affordance. Changeset: patch `@vendoai/ui`.
- Changelog + ENG-388 comment (no status change). Browser evidence: Amr
  field-tests on the rebuilt linkwarden env; screenshots for
  `docs/verification/` at PR time.

## Risks
- Upstream rebase: 56 ui files changed on main (incl. #1089 identity refactor,
  #1021 eject/thread-surface refactor) — keep every change additive; expect
  conflicts in vendo-overlay.tsx/chrome-css.ts at final rebase.
- `onThreadId` semantics for supplied ids — verify before wiring persistence
  solely through it.
