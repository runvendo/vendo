# Lane log — video-system harness

- Orientation: contract summarised + 7 self-answered questions appended to
  `HANDOFF-harness.md`. Conductor amendment (A1 cursor skin, A2 true real
  components) adopted and recorded there.
- T1: prototype copied verbatim (`diff -r` → IDENTICAL), `tools/video-studio`
  added to `pnpm-workspace.yaml` explicitly (not a `tools/*` glob —
  `tools/demo-router` is deliberately standalone). First render 14.06s/1080p30.
  `scripts/dependency-guard.mjs` reads only `packages/*`, so the studio is
  outside its remit.
- Spike before committing to the approach: mounted `ThreadMessage` under
  Remotion and rendered a still. Needed `resolve.extensionAlias` (packages/ui
  source uses ESM `.js` specifiers) and a `prerender` hook for the gitignored
  jail runtime. Both landed; probe deleted.
- Debugging notes worth keeping:
  - `template/Episode.tsx` vs `template/episode.ts` collided on macOS's
    case-insensitive filesystem → renamed to `episode-spec.ts`.
  - Remotion `defaultProps` is serialized, so an EpisodeSpec's React components
    arrived as `undefined` (React #130). Episodes are bound to their own
    component at module scope in `Root.tsx` instead.
  - `*.png` is gitignored repo-wide; evidence frames needed a narrow negation
    plus `git add -f`, else the E2E proof would have silently vanished.
  - recharts is already pinned `isAnimationActive={false}` throughout
    `packages/ui/src/kit/charts/`, so the chart is frame-deterministic for free.
- T2/T3: real components verified by rendering stills and reading them, then
  calibrating the cursor's chip waypoint against the actual rendered position.
- Suite green twice; clean-checkout render criterion re-verified after deleting
  the generated jail runtime.
- PR: https://github.com/runvendo/vendo/pull/610 (not merged — factory-check next).

## Round 2 — checker findings 1-5 (2026-07-26)

- F4 first, because it unblocked nothing else and was pure win: the repo ALREADY
  ships Onest as pinned base64 in `packages/ui/src/chrome/onest-font.gen.ts`, so
  the woff2 files were decoded out of it — same bytes the product ships, zero
  network even to produce them. `@remotion/google-fonts` dropped.
- F2 was the real work. Route: `VendoOverlay`'s own `thread` prop (documented in
  source as "the one sanctioned component-injection point (the eject seam)").
  Findings while doing it, worth keeping:
  - The panel portals to `document.body`, so the conductor's transform-wrapper
    trick does NOT reach it. It doesn't need to: `position: fixed` in a Remotion
    render resolves against a viewport that IS the film frame, so a scoped rule
    emitting the pinned CARD rect per frame is exact and reproducible.
  - Z-ORDER was the actual blocker, not geometry. The panel carries
    `z-index: 2147483001` and sits after the Remotion root in body order, so it
    painted over the cursor, the whip and the flight. Two fixes: `FILM_Z` offsets
    above that number, and `Episode.tsx` must emit NO transform on non-shake
    frames — `translate(0px, 0px)` is still a transform, still a stacking
    context, and would trap every film layer under the panel.
  - `compact = split !== null` in parts.tsx: inside the overlay the product caps
    an in-thread view at 300px with a fade and an Expand pill. So WIDGET.h was
    the prototype's invention (508) and the real card is 342. Corrected from a
    measurement, not a guess.
  - The answer's spring entrance could no longer wrap the turn (it is a child of
    the real list), so it is addressed by a per-frame rule scoped to a film
    wrapper class — motion preserved, still frame-driven.
  - The product panel has NO header row; deleted the invented one rather than
    replacing it. Recorded as Q1 in PARKED.md for Yousef.
- Calibration method worth reusing: a throwaway `RectProbe` component logging
  `getBoundingClientRect()` for a list of selectors, read out of
  `remotion still --log=verbose`. Gave exact film coordinates for the citation
  chip, the pin button, the app card and the Cadence toggle. Deleted after use.
- F3: rebuilt SceneClick from `apps/demo-accounting/src/app/settings/page.tsx` at
  the host's REAL type sizes, with the magnification moved entirely into the
  scene camera (2.0x) — a screen recording zooms, it does not restyle. Extended
  the same fix to SceneEruption's corner card, which was the same invented
  surface and would otherwise have broken continuity between scenes 1 and 2.
  Dead prototype primitives removed with it: `Toggle`, `Bar`, `cardStyle`,
  `cardShadow`.
- F1: Remotion's render CLI has no `--width/--height`, so the resolution had to
  become the episode's own. Added `STAGE` + `stageFit` to the template: an
  episode declares any resolution and the 1920x1080 stage is fitted into it.
  Smoke renders 854x480 with no flags. The fit wrapper is skipped entirely at
  1:1 — again because a `scale(1)` transform would create a stacking context.
- F5: the run summary is now the evidence README (committed), and progress.md is
  force-added.
