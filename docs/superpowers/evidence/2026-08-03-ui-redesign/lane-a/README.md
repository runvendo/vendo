# Lane A — S1 foundation: real-browser proof (2026-08-03)

Captured headless with Playwright against `demo-bank` (Maple) on `:3210`,
signed in as the seeded demo user, and against the `packages/ui` e2e harness
(the same vite harness the browser suite uses) on `:4271`. Every `before-*`
file is the identical script run against the pre-change `chrome-css.ts`.

## The headline pair

- `before.png` / `after.png` — the overlay panel on Maple's home. Before: the
  host page smears under the scrim's blur and the panel is frosted glass.
  After: flat surfaces, hairline borders derived from the host's text color,
  one soft shadow on the composer, host chrome stays crisp.
- `after.gif` — a real turn: launcher → panel → typing → the agent works.

## Build calm (spec §8) — the load-bearing claim

- `build-calm-before.gif` / `build-calm-after.gif` and
  `before-01-building.png` / `after-01-building.png`.
- Computed-style probe over every element inside `.fl-appcard` while
  `.fl-appcard-bar[data-state="building"]`:
  - BEFORE: `fl-appcard-dot :: fl-beat-orb` **and** `fl-boot-hairline :: fl-boot-sweep`
  - AFTER: `fl-boot-hairline :: fl-boot-sweep` **only**
  - both, once ready: nothing animates.
- The beat-orb pulse and the skeleton shimmer loop are removed at the sheet
  level (asserted in `packages/ui/test/chrome/s1-recipe.test.ts`); the
  skeleton's own blocks live inside the jailed iframe, so they are not
  reachable from the parent document's computed-style scan.

## The rest of the surface, before/after

`*-03-ready.png` (settled app card) · `*-04-thread-beats.png` (beats, ribbon,
bubbles) · `*-05-approval.png` (destructive approval: ceremony edge bar, one
ceremony button) · `*-06-page.png` (full-page workspace) ·
`*-07-build-failed.png` (`.fl-buildfail`, now styled — ✕ beat plus the
indented reason, no failure component) · `*-08-landing.png` ·
`*-host-launcher.png` (launcher pill) · `*-card-hover.png` (tile hover-lift,
one of the few shadows S1 keeps) · `*-connect-tray.png` (the docked tray,
opaque instead of frosted).
