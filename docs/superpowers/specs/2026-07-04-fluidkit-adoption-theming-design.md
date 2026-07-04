# fluidkit adoption + brand theming — design

**Date:** 2026-07-04
**Status:** Approved by Yousef (brainstorm session)
**Relates to:** ENG-205 (fluid motion, increments 3–4), fluidkit repo (github.com/yousefh409/fluidkit)

## Goal

Adopt the now-published fluidkit npm package as the component layer for Flowlet's own
shell chrome — while keeping host-brand integration first-class. The agent-generated
UI catalog (@flowlet/components / OpenUI) is out of scope and stays as-is.

## Decisions (locked in brainstorm)

1. **Scope:** shell chrome adopts fluidkit's component surface + finish ENG-205
   increments 3–4. The generated-UI catalog stays OpenUI/brand-token themed.
2. **Brand bridge lives upstream:** fluidkit gains a semantic theme provider;
   Flowlet maps BrandTokens into it. (Rejected: Flowlet-side wrapper layer,
   per-callsite CSS vars.)
3. **Provider shape:** semantic tokens with per-component derivation — not one
   broadcast surface-prop default. (Rejected: default-props-only provider.)
4. **Brand controls the liquid look:** theme includes `material` (glass/flat) and
   `expressiveness` (whisper→present) so glass-averse brands can dial to flat while
   keeping motion. Default: glass, whisper, tinted by accent.
5. **Dependency shape:** fluidkit becomes a hard npm dependency of @flowlet/shell.
   The vendored tarball, `loadFluidMotion()` lazy seam, and static-twin components
   are retired. Reduced-motion degradation becomes fluidkit's tested contract.
6. **Sequencing:** two stages, independently reviewable and shippable.

## Stage A — fluidkit 0.5 (theme release)

Work happens in the fluidkit repo, ships as `fluidkit@0.5.0` on npm.

### FluidThemeProvider

A React context provider taking a semantic theme:

- **Color/identity tokens:** `accent`, `surface`, `text`, `mutedText`, `background`,
  `fontFamily`, `radius`, `mode` (light/dark). Deliberately congruent with Flowlet's
  BrandTokens so the mapping is near 1:1, but named and owned by fluidkit as its own
  public concept.
- **Liquid character tokens:** `material` (`glass` | `flat`) and `expressiveness`
  (0–1 or `whisper`/`present`).

### Derivation, not broadcast

Each component derives its own surface props from the tokens with per-component
rules (a panel gets accent at low alpha; a badge a stronger tint; flat material
resolves `color` from `surface`; dark mode flips derivations). Explicit per-callsite
props always override derived values. The existing `SurfaceStyleProps` contract is
unchanged; with no provider mounted, today's defaults apply — 0.5 is non-breaking.

### Also in the release

- **React 19 peer alignment** — fixes the ENG-205 deferral (peers wired to React 18
  while hosts run 19).
- **Reduced-motion guarantee** — with Flowlet's static-fallback seam retired,
  fluidkit formally owns graceful degradation: reduced-motion and missing-GPU paths
  verified for every exported component as a tested contract.
- **Playground brand demo** — provider demoed with 2–3 contrasting themes
  (chromatic light, monochrome, dark); doubles as the visual test bed.

## Stage B — Flowlet adoption

Work happens in this repo, on a feature branch, after 0.5 is on npm.

### Dependency swap

`@flowlet/shell` moves from `vendor/fluidkit-0.3.0-d5e0fd6.tgz` to `fluidkit@^0.5`.
Delete `vendor/`, the `loadFluidMotion()` seam, and all static-twin components.
Existing fluid pieces (Thinking, FluidReveal, Ripple, ConnectTray) migrate to
direct imports.

### Brand → theme mapping

One module in the shell: `BrandTokens → FluidTheme`, mostly 1:1. New knobs default
to `material: glass`, `expressiveness: whisper`, overridable via host config — an
optional additive field on BrandTokens / `installFlowletHost` options
(backward-compatible schema). `FlowletThemeProvider` mounts `FluidThemeProvider`
alongside the existing OpenUI theme, both fed from the same BrandTokens: brand
extraction stays the single source of truth.

### Chrome migration

Flowlet chrome moves to fluidkit components:

| Chrome surface | fluidkit component |
| --- | --- |
| Overlay / panel surfaces | `LiquidPanel` / `GlassPanes` |
| Dialogs | `LiquidDialog` |
| Toasts (touches PR #34 Remix+Toasts) | `LiquidToast` |
| Menus / pickers | `LiquidMenu` |
| Tabs | fluidkit tabs |
| Badges / tooltips / progress | `LiquidBadge` / `LiquidTooltip` / `LiquidProgress` |

The generated-UI catalog is untouched.

### ENG-205 increments 3–4

Ride on this foundation:

- **inc.3 surface transitions:** Cmd+K overlay enter/exit, tab switches, library
  card→tab (likely `MorphSurface`).
- **inc.4 moment-of-consequence:** approval card materialization, automation toast.

## Error handling / degradation

- Reduced-motion, low-power, and missing-GPU users get every component rendered
  with animation degraded inside fluidkit (Stage A contract) — no Flowlet-side
  fallbacks remain.
- `refraction` remains Chromium-only and silently degrades, per fluidkit's
  existing behavior.

## Verification

- Stage A: fluidkit unit tests + reduced-motion contract tests + playground
  brand demo.
- Stage B: real-browser screenshots across demo-bank and Cadence (two contrasting
  brands), in glass and flat modes, plus Playwright `reducedMotion` emulation.
  Per standing rules, the visual result pauses for Yousef's review before build
  sign-off and again before merge.

## Out of scope

- Rebuilding the agent-generated component catalog on fluidkit primitives.
- Any change to sandbox rendering, descriptors, or the host-component path.
- fluidkit upstream gaps already tracked in the ENG-205 findings doc
  (content-sized morph, exit orchestration, media-query resolver) unless inc.3/4
  force one.
