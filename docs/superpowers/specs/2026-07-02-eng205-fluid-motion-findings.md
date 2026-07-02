# ENG-205 Fluid Motion — Integration Findings

Running log of fluidkit-integration findings: consumption mechanics, upstream API gaps,
perf numbers. Updated per increment.

## Consumption mechanics (decided increment 1)

- **Source of truth:** fluidkit `main` (repo github.com/yousefh409/fluidkit). Consumed at
  `d5e0fd6` (the tab-bar merge). The touch-up worktree carries uncommitted aurora/mesh WIP,
  so main is the stable line.
- **Linkage:** committed tarball `vendor/fluidkit-0.3.0-d5e0fd6.tgz`, packed from a clean
  clone (`npm ci && npm run build && npm test && npm pack` — 186/186 upstream tests passed
  at pack time). `@flowlet/shell` depends on it via `file:`. Rationale + refresh procedure
  in `vendor/README.md`.
- **⚠ npm-publish dependency:** the vendored tarball is a stopgap. Once fluidkit publishes
  to npm, replace the `file:` dep with a semver range and delete `vendor/`. Until then,
  every fluidkit change Flowlet wants requires a repack.
- `motion` (fluidkit's peer) is now a direct dependency of `@flowlet/shell`. demo-bank
  separately ships `framer-motion` for its own host UI — same engine, two package names, so
  a host page can carry two copies. Not a blocker; worth revisiting when fluidkit publishes.

## Enhancement-layer contract (increment 1)

`FluidThinking` (flowlet-shell) lazy-imports fluidkit: first paint is always the legacy
`.fl-typing` static dots, upgraded in place when the chunk resolves, kept forever if the
import fails. The shell never hard-depends on fluidkit at runtime; CSS keeps the dots'
reduced-motion guard, fluidkit handles its own (verified: emulated `reduce` renders three
static dots, zero style mutations over the observation window).

## Increment 1 — agent liveness (fluid thinking indicator)

- Replaced: `.fl-typing` three-dot pulse in `MessageList` dead-air state → fluidkit
  `Thinking` (`material="flat"`, `size=9`, `spread=30`, inherits `--flowlet-fg-muted` via
  `currentColor`).
- **Perf (live, demo-bank, 120 Hz display, 6 s sample spanning the working window):**
  frame p50 8.3 ms, p95 9.1 ms, 0 frames > 33 ms — no jank; zero console errors/warnings.
- **Observation for the taste pass:** at 9 px drops the merge/split necks are subtle; the
  cluster reads as organic drifting more than overt metaball merging. `size`/`spread`/
  `speed` are single-prop tunables on one line of `FluidThinking.tsx`.

## Increment 2 — skeleton → view fluid reveal

- New `FluidReveal` render-slot wrapper: a skeleton and the ui item replacing it now share
  one React identity (per-message slot keys in `MessageList` — the raw items have different
  part-index keys, which previously forced a hard remount). On an *observed* skeleton→view
  flip the card surface springs to its new height while the skeleton face fades/blurs out
  and the view face rises/un-blurs in. Restored threads mount statically (no flip observed).
- **Surface/content split honored:** only the slot container's height animates; faces get
  opacity/translate/blur. The sandboxed iframe is never scaled — generated UI cannot warp.
- Preload: the motion chunk loads when a skeleton mounts, seconds before the view lands, so
  the first reveal animates. Toolkit missing / reduced motion → instant swap (verified live:
  emulated `reduce` produced no exit layer and no inline height).
- **Perf (live, demo-bank):** reveal transition ≈ 550 ms; instrumented rerun over the full
  skeleton→settle window recorded **zero frames > 33 ms** (a first, cold-compile run showed
  3 long frames from Next dev-server chunk compilation at view arrival — not reproducible on
  warm runs, not the animation).
- demo-bank's host-side framer-motion `Reveal` in `render-node.tsx` removed: it would have
  double-animated with the shell reveal, and its `scale: 0.985` entrance warped sandbox
  content (against the no-warp principle).

## Upstream API gaps

None hit in increment 1. The `Thinking`/`Droplets` API covered the liveness use case as-is
(role=status, label, material, reduced-motion, off-screen pause all built in).

Increment 2 (file upstream when fluidkit work resumes):

1. **No content-sized morph primitive.** `MorphSurface` morphs between *fixed* pixel
   geometries (pill↔panel). The skeleton→view reveal needs a surface that springs between
   two *content-measured* boxes with cross-fading faces — e.g. `MorphSurface` accepting
   `size="auto"` per face, or a dedicated `RevealSurface`. Flowlet implements this shell-side
   for now (`FluidReveal`) using the `motion` peer directly plus fluidkit's reduced-motion
   resolver — the headless-escape-hatch route `useFlow` documents, not a fork of fluidkit.
2. **No exit orchestration in `useFlow`.** The headless hook covers enter/reorder but has no
   AnimatePresence-style affordance for holding an outgoing face during a cross-fade;
   `FluidReveal` keeps the previous children manually. An upstream `useReveal`/exit variant
   would subsume it.
3. `resolvePrefersReducedMotion` resolves a *supplied* preference; a non-hook media-query
   reader (for event-time checks outside render) would remove the `matchMedia` boilerplate
   consumers write around it.

Integration gotcha (Flowlet-side, not an upstream bug): storing a fluidkit component in
React state requires the `useState(() => C)` initializer form — a bare component function
passed to `useState`/`setState` is invoked as a lazy initializer/updater and crashes.

## Pre-existing issues noticed (not touched, not mine)

- `pnpm lint` fails on main in demo-bank sources (react-hooks setState-in-effect and
  ref-in-render errors in `transactions/`, `FlowletPoller.tsx`, `filters-bar.tsx`).
