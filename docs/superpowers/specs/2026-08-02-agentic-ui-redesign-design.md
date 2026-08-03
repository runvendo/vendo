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

**Apps & automations placement (pick T4 + named doors):** the home stays
pure (greeting · suggestion rows · app shelf · composer). The sidebar gets
two nav rows under New chat — **Apps** and **Automations** — each opening
its own page in the main column: Apps = the live-tile grid with room to
breathe ("ask below to build a new one"); Automations = status cards
carrying schedule, last-result receipt ("sent Friday · $840, 12% under your
usual pace"), and Pause/Resume. Rejected: running-line under the shelf
(T1), mixed widget grid (T2), two shelves on the home (T3), the combined
"Your stuff" page (T4 as first drafted).

### 11. The design language: neutral (pick S1)

ChatGPT/Codex is the taste reference for STYLE ONLY — the structure stays
ours (a literal Codex clone was rejected as "too much"). The default chrome
adopts the neutral language:

- Pure grayscale; ONE black accent. No frosted glass, no tints.
- Borders at ~5% alpha — felt, not seen; hairline dividers.
- Big soft radii (composer ~26px, cards ~18px, rows ~10px).
- System type at calm weights (460–550); display greeting ~30px/500;
  secondary text in muted grays, never smaller than legible.
- Shadow ONLY where it carries meaning (the composer card, hover-lift on
  tiles); everything else is flat.
- Airy: sidebar rows ~14.5px with comfortable padding; generous column
  margins; the centered column caps at ~660px.

Final center structure as styled: sidebar = New chat · **Apps** ·
**Automations** (the two named doors) · Needs-you (only while non-empty,
numbered badge) · chats grouped by recency (running rows pulse) · user row. Main = greeting, two personalized
suggestion ROWS (noticings with icons — never generic chips), the live app
shelf (HB), the composer card. Rejected in this round: S2 warm-serif
(Anthropic register), S3 crisp-editorial (Linear register), and the
Codex-literal chrome (search/bell, Scheduled nav, mode chip, account
selector — parked as structure candidates, not styled in).

Hosts still re-theme everything via the existing VendoTheme tokens; S1 is
the out-of-the-box feel, not a mandate.

**S1 is a RECIPE over host tokens, not a palette (2026-08-03).** The
default look derives from the host's VendoTheme exactly as the chrome
already does — background, surface, text, accent, fonts, radius all flow
from host tokens; S1 defines the RELATIONSHIPS (border alpha ~5% of
foreground, the radius scale, muted-text mixing, shadow only on floating
elements, spacing rhythm). A warm-branded host renders warm S1; Maple
renders neutral S1. Dark mode: DEFERRED — the derived-scheme machinery
(ENG-226) stands; exact dark default values are picked during the build,
not as a design decision now.

**Scope confirmed (2026-08-03): the S1 pass applies to EVERY surface** —
the overlay panel, thread (bubbles/beats/app cards), approval and grant
cards, toasts, waiting strip, launcher pill, share dialog — one re-token
pass over `chrome-css.ts`. The frosted-glass identity is retired. Known
consequence, accepted: every existing deployment visibly changes chrome on
upgrade (brand tokens unchanged).

### 12. The center is a PAGE inside the host's app — and mobile (pick P1)

Standing law from this round: **we never bring an app shell of our own.**
The center is a page the host routes to; the host's chrome (its header, its
navigation, its identity, its logged-in user) surrounds us everywhere.
Consequences:

- The center's sidebar drops the brand row and the user row — it is an
  in-page rail (New chat · Apps · Automations · Needs-you · chats), not an
  app frame.
- **Mobile = P1, one self-contained page under the host's tab/menu item:**
  a compact in-page header (Assistant title · chats · apps · automations ·
  new), a slide-in sheet for conversation history, stacked home content,
  composer pinned low. The host mounts one thing; coherence stays ours.
- The P2 pieces (chat surface, app shelf, automations list as separate
  exports) remain available for hosts that compose their own navigation —
  the adapter philosophy applied to UI. The overlay (P3) stays the floor
  every host gets with zero routing work.
- Rejected as the default: our own bottom tab bar (double chrome inside an
  app that has one), our own hamburger-with-brand app header, and
  center-less mobile.

### 13. Panel and center are strangers (pick R1)

The overlay panel and the center page are **independent interfaces over one
shared thread store** — the host composes whichever it wants into its app.
No cross-navigation affordances in either direction: no "Open in Assistant"
in the panel, no auto-handoff of big work. The panel keeps its full
capability everywhere (V4's in-panel split stage stands); the center is
simply another mount. Completion toasts and badges open the surface they
were raised on. Discovery of the center is the host's navigation's job, not
ours. (Rejected: the satellite arrow R2, the teaser auto-handoff R3 —
the latter also violated G1's "nothing moves without the user".)

### 14. Cold start: the ghost shelf (pick CS2)

Day zero the home shows the shelf as **dashed ghost tiles** — named examples
("Spending breakdown — see where July went · tap to build") that advertise
what the product does before anything exists; tapping one runs the first
build and the ghosts retire for good. Suggestions are generic starters on
day zero (no history to notice from) and become personalized noticings
later. Apps/Automations pages carry one honest empty line each ("Nothing
yet — anything you build lands here, live"). The sidebar earns its first
chat row with the first build. Ghost prompts are host-authorable (the
existing starter-suggestion machinery). Rejected: empty-gap quiet start
(CS1), self-destructing guide card (CS3).

### 15. Failure is conversation — no failure components (the Claude Code way)

There is NO failure UI. The errored beat (existing ✕ vocabulary) stays in
the record, and the agent handles its own failure in its own voice: one
silent self-retry (possibly a different approach — "let me pull the month
in smaller pieces"), narrated as new beats. If it still can't, it says so
in prose under a standing copy law: **what happened · nothing was changed ·
what happens next** — and may offer a partial path. Retry affordance = the
composer and the existing Regenerate turn action; no buttons, no chips, no
cards. Automations: a failed run shows on the automation card's sub-line
("failed Friday"); permission failures keep the settled Grant & re-run
card. Rejected along the way: structured failure cards (three stylings),
inline retry line, composer retry chip — all read as furniture.

### 16. One card shell, three laws (the card audit)

Audit finding: cards look different in use because there is no designed
reference (the gallery contains zero cards; the only isolated render is one
perfect-data test fixture), the card's body is chosen by its DATA (three
mutually exclusive layouts; empty in-thread schema degrades $47.50 to
"4750 (unit not specified)" and drops the description), and the "same"
card is re-implemented at least four times (thread card, waiting-queue
row, voice strip, embed resolved-card) with six hardcoded eyebrows, five
icon-well sizes, three primary-button variants, ancestor CSS that strips
card chrome in the mobile sheet, unmatched class names (Share dialog), a
no-fallback logo CDN, and a developer-voice policy banner auto-prepending
on BYO surfaces.

The fix, decided:

1. **One shell component** — eyebrow · one-size icon well · title ·
   MANDATORY plain-words line · field rows / list body · actions · byline
   — built once in the S1 recipe; approval, connect, standing-access,
   automation, and paused/adoption are contents only. Every surface
   (thread, queue, activities, sheet, voice, embeds, center) renders the
   same shell; the queue's WaitingRow and voice's consent strip become
   thin wrappers around it. Ancestors may size it, never undress it.
2. **Data hardening** — the descriptor (schema + title + description)
   travels with the approval to every surface, so money always formats
   and titles never fall to prettified slugs; raw server previews
   (tool slug + canonical JSON) are never rendered to end users.
3. **Consumer-voice guarantees** — the policy notice and any
   developer-voiced error never render on end-user surfaces; remote
   logos always carry an onError fallback glyph; the dead/duplicate card
   CSS and unmatched class names are removed in the S1 pass.

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
