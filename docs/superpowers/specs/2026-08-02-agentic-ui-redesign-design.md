# Agentic UI redesign — design decisions

**Date:** 2026-08-02 (amended 2026-08-03 with the polish + AI-center rounds)
**Status:** decided with Yousef, awaiting spec review
**Method:** live design canvas (interactive HTML replicas on the real
`@vendoai/ui` chrome stylesheet + Maple theme, one decision at a time).
The canvas itself is throwaway (`design-canvas/`, gitignored); this document
is the record.

## Goal

The engine became genuinely agentic (claudeCode() live sessions, instant()
skeletons, automations) while the UI still presents every turn like a short
chatbot exchange. This redesign makes the surface FEEL agentic — visible
work, honest background behavior, attention that finds you — without
sacrificing the calm, brand-native posture the chrome was built on.

## Decisions

### 1. The transcript shows the work (pick B)

Tool steps render in the conversation as checklist **beats**: pulsing orb
while running, tick + humanized label + short result ("Reading July's
transactions · 142 transactions") when done. When the turn settles, the
beats **collapse into one reopenable summary line** — "✓ Did 4 things ·
7.1s" — so history stays scannable. The transcript becomes the record of
what the agent did.

- Labels ride the existing ENG-216 humanization pipeline (host ToolMeta
  wins; never raw slugs). The `BuildBeat` component already exists in
  `packages/ui/src/chrome/build-beat.tsx`; today `parts.tsx` renders it only
  for errored calls.
- **This reverses lane pick C1** ("the transcript stays beat-free; the
  StatusRibbon narrates") — a deliberate supersession, decided on the
  canvas against a faithful baseline. The ribbon's tool-narration role goes
  away; `WorkingRibbon` (the between-steps voice) and error surfacing are
  unchanged. `docs/archive/contracts/08-ui.md` needs a matching amendment.
- Rejected: fold-as-you-go (B1), think-aloud prose interleave (B2),
  timeline spine (B3), expandable drawer (C), plan card (D), ambient
  motion-only (E), stage-always (F).

### 2. Background = "panel closed while running" (pick G1)

**Closing is leaving. Nothing folds itself, ever.** If the user closes the
panel mid-run, the run continues; the launcher pill becomes a live progress
indicator (current beat label + progress ring); a toast announces
completion. If they never close it, everything completes in the panel.
Waiting is always a first-class path.

- Rejected: agent offers a "close & ping me" chip (G2), auto-tuck with a
  "keep watching" out (G3). No announcement line, no auto-fold.

### 3. The thread is the record (pick H1)

No inbox surface. The completion toast deep-links into the conversation,
where the finished turn sits with its collapsed beats and timestamp
("Did 4 things · finished 2:14 pm"). An ignored toast withdraws; the
launcher keeps a quiet dot until the user next opens the panel. (The dot
marks unseen RESULTS; the numbered badge of decision 4 counts ASKS — two
distinct signals, dot ≺ number.)

- Rejected: "while you were away" strip on the landing (H2), dedicated
  inbox home (H3).

### 4. Attention lives in the waiting strip + a numbered badge (pick N1)

Anything that needs the user — outbox ready-to-send cards, Grant & re-run
failure cards (both per the settled automations-pack design; no parking, no
silent failures) — surfaces as:

- a slim **"Waiting on you · N" strip** docked above the composer on every
  thread until empty; tapping expands the cards in place; acting clears it
  (this is the shipped WaitingQueue idea, restyled and made count-first);
- a **numbered badge on the launcher pill** (a count, not a bare dot), so
  the user knows before opening.

- Rejected: pill label text as the signal (N2), host-notification-bell as
  the primary channel (N3). The §3 host notification hook remains available
  to hosts, but Vendo's own floor is the strip + badge.

### 5. View arrival is a hybrid, hinted at plan time (pick V4)

Small answers land **inline** as compact app cards (with the Expand
affordance); big builds **auto-open the split view** and assemble on the
stage — skeleton first — while the chat narrates from the rail.

- **The brain declares a display hint at plan time** (`inline | stage`) —
  it knows the shape before the fill, so the stage can open the moment the
  build starts (where instant()'s ≤6s skeleton is actually visible).
- The rule only sets the STARTING posture: inline cards keep Expand, staged
  views keep Back-to-chat. A wrong hint costs one tap.
- Uses the existing split-view machinery (`split-view.tsx`, feature/expand
  affordances, render seam) — the new pieces are the plan-format hint field
  and the auto-open trigger.
- Rejected: card-always (V1), stage-always (V2), grow-in-place (V3),
  measured-size rule (decides too late to stage the build).

### 6. Motion system: fluid (pick M2)

Soft blur-to-focus entrances (~320–460ms, `cubic-bezier(0.32,0.72,0,1)`),
staggered bar/section fills, iOS-sheet easing throughout. Calm and
unhurried — "smoothness reads as care." Applies to turns, beats, cards,
strips, the pill, and the stage.

- Respects `prefers-reduced-motion` and the theme's `motion` token (hosts
  can tone down; the personality is the default, not a mandate).
- Rejected: crisp/instant (M1), springy/overshoot (M3 — bounce in a bank).

### 7. Host-page posture stays invited-only (pick P1)

On the host's own pages the agent appears only where invited: empty slots
("This space builds itself") fill when the user asks and pins; pinned views
stay data-live but never change shape or speak uninvited.

- **P2 (contextual suggestions) and P3 (agent-maintained living surface)
  are parked, not rejected.** P3 is explicitly future work that composes
  two planned pieces: an automation whose job is maintaining a pinned app
  (automations pack) + user-memory/personalization. Revisit when those land.

## Decisions — 2026-08-03 polish + AI-center rounds

### 8. The build animates ONE thing (picks A2 + D1)

Today a build runs four loops at once (pulsing beat orb, pulsing card dot,
sweeping hairline, skeleton shimmer). Now: **the hairline gliding across the
card bar is the only moving element** during a build — beat orbs go static
(the "…" carries the working state), the card dot stops pulsing, the
skeleton stops shimmering.

And the build step narrates ONCE: **the build gets no beat line — the card
IS the step** (D1). The card bar reads "Building your view…" + hairline,
flips to the app name when live; the settled "Did N things" summary still
counts it.

### 9. The composer stays exactly as shipped

Furniture unchanged (dock · attach · field · mic · accent send; Stop
appears mid-turn). Explored and REJECTED for now: plus-menu consolidation,
two-row layout, quiet-until-touched, ghost autocomplete, page-context chip,
intent preview, instant answers, slash verbs. (E2 context-chip and E3
intent-preview were noted as the strongest future candidates — parked, not
scheduled.)

### 10. The AI center is the ChatGPT shell (pick X1)

The full-page workspace (VendoPage's five tabs + button-stack sidebar) is
replaced by the ChatGPT shape, worn by the host's brand:

- **Sidebar:** New chat · a pinned **"Needs you" section** that exists only
  while asks are waiting (badge; settle → it disappears) · conversations
  grouped by recency; a running background turn shows a quiet pulse on its
  row; user row at the bottom. No apps/automations lists in the sidebar
  (the Y3 library and its declutter variants were rejected as clutter).
- **Main:** one centered column; the thread uses everything already decided
  (B beats, D1 card-is-the-step, A2 hairline, M2 motion).
- **Home / empty state (pick HB):** the hero composer ("What can I help
  with?") with **your apps as LIVE tiles directly beneath it** — real
  rendered views, not names. Tap a tile → the app opens full in the column
  and you change it by asking. Apps are the marquee; asking stays first.
  (HC "home IS the dashboard" was the runner-up; HA pure-ChatGPT the
  control.)
- Codex-style task-list sidebar (X2) rejected as the default; its status
  language (running/needs-you/done) survives on the chat rows.

Open detail from this round: where automations live in the center (the
sidebar library was rejected; candidates: a quiet "running for you" line
under the app shelf, or conversation-only).

## What this is NOT

No new surfaces (no inbox, no notification center), no auto-folding panel,
no capability changes, no consent changes (the automations-pack consent
design stands as settled), no mobile-specific redesign in this wave (the
split view's mobile takeover is existing behavior; the hybrid's stage maps
to it).

## Build notes (for the eventual plan — not scoped here)

- New: beat rendering for successful calls in `parts.tsx` + collapse
  summary; pill progress mode + numbered badge + completion toast
  deep-link; waiting strip w/ count; plan-format display hint + auto-stage
  trigger; M2 motion token pass over the chrome sheet.
- Amend: `08-ui.md` (C1 supersession, strip, pill states); plan dialect
  (display hint).
- Existing and reused: BuildBeat, humanization pipeline, split view, render
  seam/skeletons, WaitingQueue, morph-toast, launcher, VendoSlot/pins,
  automations card inventory.
