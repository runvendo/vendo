# ENG-205 side-quest — Connect-tools entry point moves into the chat bar

**Ask (Yousef, verbatim intent):** the "+ Connect tools" pill above the thread goes away;
connecting/managing integrations becomes part of the composer/chat bar, with fluid motion
where it earns it. Design exploration: 2–3 treatments, recordings on the real pipeline,
PAUSE for his pick. The Composio connect FLOW itself is untouched — this is the entry
point and its motion only.

## The three treatments (all real, switchable via a `connectEntry` prop)

- **A — `icon-tray`:** a compact tools button sits in the bar next to attach, with a
  connected-count badge. Tapping it morphs a liquid tray up out of the bar edge (height
  spring + un-blur, transform-origin bottom) holding the existing picker. fluidkit Ripple
  on the press.
- **B — `chip-cluster`:** connected tools live in the bar as a cluster of overlapping
  brand coins (up to 3, then "+n"); a dashed "+" coin when none. The cluster is the
  button; coins spring in/out as tools connect/disconnect. Same liquid tray.
- **C — `bar-morph`:** the bar itself is the surface — tapping the tools button morphs
  the whole composer into the picker panel (container height springs, the textarea face
  cross-fades to the picker face; faces never scale). Closing morphs back. The boldest,
  closest to fluidkit's pill→panel MorphSurface idiom.

## Shared rules

- Enhancement layer throughout: toolkit missing → tray/morph opens instantly (plain
  show/hide); reduced motion → same instant behavior (checked at event time via the
  fluid-motion loader from increment 2). Ripple degrades to nothing (fluidkit built-in).
- `connectEntry` defaults to `"rail"` (today's pill) until Yousef picks — nothing
  regresses while the exploration is under review. The winner then becomes the default
  and the rail + losing variants are deleted.
- All three surfaces must eventually work with the winner; the exploration records on the
  page surface (overlay inherits via prop spread; slot forwarding is part of
  productization).
- Connected/unconnected states shown in each recording via real disconnect/reconnect
  (demo disconnect is a local flip; reconnect fast-completes while the Composio account
  is still ACTIVE).

## Build

1. `FluidRipple` — lazy fluidkit `Ripple` (FluidThinking pattern; plain wrapper fallback).
2. `ConnectDock` — the in-bar affordance (variants `icon` / `cluster`) + `ConnectTray`
   (anchored above the bar, fluid open/close via the increment-2 loader).
3. `ConnectBarMorph` — treatment C's two-face container (FluidReveal technique,
   bidirectional).
4. `Composer` gains an `accessory` slot (rendered beside attach); `FlowletThread` gains
   `connectEntry` and hides the rail for dock variants; `FlowletPage` forwards it;
   demo-bank's flowlet page maps `?connect=a|b|c`.
5. TDD per component (structural: states, toggle, fallback-instant, reduced-instant,
   Esc/outside close); full suite + typecheck + build.
6. Live runs per treatment: open/close, disconnect + reconnect (real pipeline), reduced
   mode. Recordings `motion-connect-option-{a,b,c}.gif` (+ `-reduced`), mp4 originals.
7. Findings update; commit; worktree comment; PAUSE for Yousef's pick.
