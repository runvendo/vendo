# fluidkit Adoption Stage B Implementation Plan (Flowlet side)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** @flowlet/shell consumes fluidkit 0.5 as a hard dependency, maps host BrandTokens into `FluidThemeProvider`, migrates the 0.5-available chrome onto fluidkit components, retires the `loadFluidMotion()` seam, and ships ENG-205 increments 3–4 — browser-verified across two brands.

**Architecture:** One brand→theme mapping module in the shell feeds fluidkit's provider from the same BrandTokens that drive the OpenUI theme; chrome components swap to fluidkit equivalents surface-by-surface, each behind the shell's existing test suite plus screenshot verification. The agent-generated catalog is untouched.

**Spec:** `docs/superpowers/specs/2026-07-04-fluidkit-adoption-theming-design.md` (post-Codex-review revision).

**Dependency note:** until Yousef publishes fluidkit 0.5 to npm, the shell consumes a locally-packed 0.5 tarball from the Stage A branch (same vendor mechanism as today); the PR notes the one-line swap to `fluidkit@^0.5` at publish. The PR must not merge before the fluidkit 0.5 PR does.

---

### Task 1: Dependency swap + brand→theme mapping

- [ ] Pack fluidkit 0.5 from the Stage A branch (AFTER its version bump to 0.5.0 — verify the packed artifact's version and exports before wiring); point `@flowlet/shell` at it, replacing the 0.3.0 tarball reference in package.json and pnpm-lock; `motion` stays a regular dependency (it also satisfies fluidkit's peer).
- [ ] **Input path (Codex):** the shell currently has no brand input — `FlowletShellProvider` only takes `theme`/`cssVars`. Add an optional `brand?: ManifestTheme` (from @flowlet/core, structurally BrandTokens) plus `fluid?: { material?: "glass"|"flat"; intensity?: LiquidIntensity }` to the shell provider config; thread it from `@flowlet/next`'s FlowletRoot and both demo apps' roots. All optional — existing consumers unaffected.
- [ ] New shell module `brand-to-fluid-theme`: ManifestTheme → FluidTheme (accent/surface/text/mutedText/background/fontFamily 1:1; radius parsed `"16px"` → 16; mode passthrough); `fluid` knobs merged in when set. Unit tests: mapping correctness, radius parsing, knob defaulting.
- [ ] Mount `FluidThemeProvider` where the shell already applies brand theming so every element (page/overlay/slot) sits inside it. OverlayPanel owns a portal — mount the provider inside the portal subtree (it reapplies CSS vars there today; the fluid theme needs the same treatment). Tests: a fluidkit component rendered in each element AND inside the overlay portal picks up the brand accent.
- [ ] **Test scaffolding (Codex):** add a shell `vitest.setup.ts` stubbing ResizeObserver (+ rAF if needed) — fluidkit surfaces construct ResizeObserver directly and shell's jsdom config has no stubs today.

### Task 2: Retire the loadFluidMotion() seam

Replacement table (each row = its own commit, tests updated in the same commit):

| Shell primitive | Replacement |
| --- | --- |
| `FluidThinking` | becomes a thin adapter over a static fluidkit `Thinking` import — shell callsites pass `spread` (e.g. IntegrationsPicker's `spread={15}`), which 0.5's `Thinking` doesn't have; the adapter maps old props to the new API (or callsites are updated), lazy path deleted |
| `FluidRipple` | fluidkit `Ripple` imported directly; static-twin path deleted |
| `FluidReveal` | keeps its hand-rolled reveal, but imports `motion` + fluidkit's reduced-motion resolver statically; the lazy seam indirection is deleted |
| `ConnectTray` | same treatment as FluidReveal (static imports, seam deleted) |

- [ ] Apply the table; delete `fluid-motion.ts` and its tests once nothing imports it; reduced-motion behavior re-verified via the existing Playwright `reducedMotion` emulation tests.

### Task 3: Chrome migration (0.5-available surfaces only)

Surface-by-surface, one commit each, existing behavior tests stay green:

- [ ] `OverlayPanel`: **the shell keeps ownership** of portal, focus trap, Escape handling, and close-button placement (deliberate a11y decisions with tests) — `LiquidPanel` becomes the visual surface inside it, not a `LiquidDialog` takeover (Codex: LiquidDialog double-owns portal/focus and would break the focus tests).
- [ ] Tabbed page element (`FlowletPage`): `LiquidTabs` renders the **selectable tab bar only**. Panes keep the existing always-mounted-`hidden` mechanism (each pane holds a live FlowletProvider chat — LiquidTabs' panels unmount inactive content and would drop thread state), and the non-tab `+` new-tab action renders beside the bar, outside the item list.
- [ ] Primary action buttons (full-size only: composer send where parity allows) → `LiquidButton`. Composer's 34×34 icon buttons are NOT migrated (LiquidButton's geometry is a 160×48 pill); they keep their current styling. Anything whose look regresses stays and is noted in the PR.
- [ ] Explicitly NOT migrated (deferred to 0.5.1 per spec): toasts (`FlowletToast`), menus/pickers (`IntegrationsPicker`), form controls. The shell has no tooltip surface today (Codex) — no tooltip row. All keep brand CSS-var theming.

### Task 4: ENG-205 increment 3 — surface transitions

- [ ] Overlay enter/exit (Cmd+K): fluid morph via `MorphSurface`/LiquidPanel's own transitions; reduced-motion = instant.
- [ ] Tab switches in the page element: content cross-fade coordinated with LiquidTabs' indicator.
- [ ] Library card → tab: the card-opens-tab flow lives in the demo apps' assistant pages (not shell's FlowletPage — Codex), so this treatment lands partly in shell primitives, partly in demo-bank/Cadence pages; morph continuity where feasible, plain fade where not (note which in the PR).

### Task 5: ENG-205 increment 4 — moment-of-consequence

- [ ] ApprovalCard materialization: entrance that reads as "something needs you" (fluidkit reveal/ripple vocabulary), calm by default, reduced-motion = instant.
- [ ] Automation toast moment: since LiquidToast is deferred, apply the motion treatment to the existing toasts — note there are two (Codex): shell's undo `FlowletToast` and demo-bank's app-level automation toast component; treat each where it lives (entrance only, no component swap).

### Task 6: Verification + PR

- [ ] Full repo gates: `pnpm test`, `pnpm typecheck`, `pnpm lint`. The dependency-guard test protects `@flowlet/runtime` only — fluidkit is a shell dep, so the guard must pass UNCHANGED (proof the runtime stayed untouched); do not edit its allowlist.
- [ ] Real-browser verification: demo-bank AND Cadence, each screenshotted across — default glass, `material: flat` config, dark-brand if a demo has one, and Playwright `reducedMotion` emulation. Screenshots go in the PR.
- [ ] Open the Flowlet PR (feature branch; never merge — Yousef reviews visuals per standing UI gate). PR body: screenshot matrix, the 0.5-tarball→npm swap note, deferred-surfaces list, ENG-205 inc.3/4 notes.

## Out of scope

- Toasts/menus/controls migration (0.5.1, after fluidkit's controls wave merges).
- Catalog (@flowlet/components), sandbox rendering, descriptors.
- fluidkit changes beyond consuming 0.5 (upstream gaps go to the findings doc).
