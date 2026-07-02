# ENG-205 Increment 2 — Skeleton → View Fluid Reveal

**Goal:** The skeleton→rendered-view swap becomes a fluid morph — the card surface glides to its new size while the skeleton dissolves and the real view rises/un-blurs in. The perceived-performance hero moment.

**Approach:** Same enhancement-layer contract as increment 1. A new `FluidReveal` wrapper in `@flowlet/shell` owns one "render slot" with a stable key across the skeleton→ui item swap (today the two items have different keys, so the swap is a hard unmount). Animation only plays on an *observed* skeleton→view flip — restored/reopened threads mount statically.

**Decisions (for Yousef at the increment review):**
- **Surface vs content split (fluidkit's core principle):** the morph animates the card geometry (height spring) and cross-fades layers. The view content — a sandboxed iframe — only ever fades/translates; it is never scaled, so generated UI never distorts. Zero motion *inside* the sandbox is untouched.
- **fluidkit surface:** main has no content-sized morph primitive (`MorphSurface` is fixed-geometry pill↔panel) and no exit orchestration in `useFlow` — both filed in the findings doc as upstream gaps. The sanctioned route used here: fluidkit's exported reduced-motion resolver + its `motion` peer (which `useFlow` is explicitly designed to hand work to) for the height spring and layer fades, with fluidkit's flow easing.
- **Preloading:** the motion chunk lazy-loads when a skeleton mounts — seconds before the view lands — so the first reveal (the demo moment) animates. If it hasn't loaded or fails, the swap is instant (today's behavior).
- **Reduced motion:** checked at flip time via fluidkit's resolver; instant swap, no cross-fade, no height animation.
- **demo-bank cleanup:** `render-node.tsx`'s own framer-motion `Reveal` (entrance with scale 0.985) is removed — it would double-animate with the shell reveal and its scale warps sandbox content.

## Steps

1. **Loader seam (TDD):** `fluid-motion.ts` — cached lazy loader for `{ animate }` from motion + `resolvePrefersReducedMotion` from fluidkit; resolves `null` on failure. Mockable seam for tests.
2. **FluidReveal (TDD):** persistent wrapper; records its height while in skeleton phase; on flip with motion available + motion allowed: keeps the previous skeleton as an absolutely-positioned exiting layer (fade+blur out), reveals the entering view (opacity/translate/blur in, no scale), springs the container height old→new, then releases to auto. Tests: instant swap when the loader fails; instant swap under reduced motion; animated path (exiting layer appears then goes; animate called for height + layers); no animation on fresh mount in view phase.
3. **MessageList wiring (TDD):** compute per-message render-slot keys so a skeleton and the ui item that replaces it share one wrapper identity; wrap both cases in `FluidReveal`. CSS: `.fl-reveal` preserves the list's flex layout and 14px gap for its children.
4. **demo-bank:** drop the host-side `Reveal` wrapper in `render-node.tsx`.
5. **Verify:** full suite/typecheck/build; live demo-bank run with a render_view prompt; frame-time sampling across the reveal; reduced-motion emulated run.
6. **Record:** `motion2-fluid.gif` (+ close-up) and `motion2-reduced.gif`, mp4 originals, worktree root.
7. **Document:** findings update (upstream gaps above, perf numbers). Commit, worktree comment, pause for Yousef.

## Risks / notes

- The sandbox iframe self-resizes after mount (ENG-184 shim); the height spring targets the height at flip and later growth jumps as today — acceptable, noted for review.
- Two views in one message: slot indices pair by order; stable because message parts are append-ordered.
