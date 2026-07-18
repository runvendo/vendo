# Wave 2: Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach end users the app is moldable: the whisper launcher (one-time pulse + caption) and the greeting-as-tutorial first message with tappable starter prompts — host-configurable, defaults on, every element fires once per user ever.

**Architecture:** Lives in the overlay/thread chrome (post-Lane-A layout). A small persistent "seen" store (localStorage, keyed per deployment) enforces the fire-once rule. Configuration is one dial on the overlay (`discoverability`: quiet | default) plus a greeting config (intro line + starter prompts) accepted via provider/overlay props; a repo-level default file seeds it so init can generate one later.

**Precondition:** Lane A (shelf core) MERGED. Mockup reference: session artifact `discoverability-options.html` (whisper = option B, greeting = option A); the brainstorm doc §6 is the decision record.

**Source of truth:** `docs/brainstorms/ui-usage-dx.md` (§6). Locked: whisper + greeting are the defaults; coach-marks and cold-composer are config options only if trivially cheap — otherwise quiet/default is the v1 dial and coach-marks are OUT (do not build a tour engine).

**Hard boundaries:** No nagging: each element renders at most once per user per deployment, ever, including across reloads mid-animation. No new deps. Never commit to main; PR from this lane's branch.

---

### Task 1: Fire-once store

**Files:** new small module in `packages/ui/src/chrome/`.

- [ ] TDD a tiny persistent flag store (namespaced localStorage key, SSR-safe, graceful when storage is unavailable — treat as already-seen so degraded environments never nag)

### Task 2: Whisper launcher

**Files:** overlay launcher (post-refactor location), `chrome-css.ts` tokens.

- [ ] First eligible visit only: one gentle pulse on the pill + a small caption ("You can reshape this app" + one-line sub) auto-dismissing after ~6s, marked seen immediately on first render (not on dismiss)
- [ ] `discoverability="quiet"` disables it; respects `prefers-reduced-motion` (caption without pulse)
- [ ] Browser-verify first-visit vs revisit in demo-bank; screenshots of both

### Task 3: Greeting-as-tutorial

**Files:** thread chrome (post-refactor layout); provider/overlay prop plumbing.

- [ ] On a user's first-ever conversation open (fire-once store; only when the thread has no history), render the greeting locally as the first assistant-style message: intro line + 2–3 tappable prompt chips; tapping a chip prefills the composer (NOT auto-send)
- [ ] Greeting content: host-supplied via prop; default = a generic capable intro with one molding prompt; if `.vendo/greeting.json` exists the umbrella wires it through (file format: intro + prompts list — document it; init-side generation belongs to the install-dx init lane, not here — leave a coordination note in the PR)
- [ ] The greeting is presentation-only: never persisted to the thread, never sent to the model
- [ ] Browser-verify in both demos (Cadence should read on-brand with catalog-flavored example prompts in its greeting file); screenshots

### Task 4: Dial + docs + finish

- [ ] One `discoverability` prop controls both elements (quiet | default); contextual affordances (slot ghost, remix hover, Trigger) are untouched by the dial — they're host-placed
- [ ] Document the dial and greeting file in `docs/host-components.md`
- [ ] Full gates green; PR with screenshots; signal `needs-review` then `triage-complete` via worktree comment
