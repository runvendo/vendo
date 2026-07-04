# fluidkit Adoption Stage B Implementation Plan (Flowlet side)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** @flowlet/shell consumes fluidkit 0.5 as a hard dependency, maps host BrandTokens into `FluidThemeProvider`, migrates the 0.5-available chrome onto fluidkit components, retires the `loadFluidMotion()` seam, and ships ENG-205 increments 3–4 — browser-verified across two brands.

**Architecture:** One brand→theme mapping module in the shell feeds fluidkit's provider from the same BrandTokens that drive the OpenUI theme; chrome components swap to fluidkit equivalents surface-by-surface, each behind the shell's existing test suite plus screenshot verification. The agent-generated catalog is untouched.

**Spec:** `docs/superpowers/specs/2026-07-04-fluidkit-adoption-theming-design.md` (post-Codex-review revision).

**Dependency note:** until Yousef publishes fluidkit 0.5 to npm, the shell consumes a locally-packed 0.5 tarball from the Stage A branch (same vendor mechanism as today); the PR notes the one-line swap to `fluidkit@^0.5` at publish. The PR must not merge before the fluidkit 0.5 PR does.

---

### Task 1: Dependency swap + brand→theme mapping

- [ ] Pack fluidkit 0.5 from the Stage A branch; point `@flowlet/shell` at it (replacing the 0.3.0 tarball reference); `motion` stays a regular dependency (it also satisfies fluidkit's peer).
- [ ] New shell module `brand-to-fluid-theme`: BrandTokens → FluidTheme (accent/surface/text/mutedText/background/fontFamily 1:1; radius parsed `"16px"` → 16; mode passthrough). Liquid knobs (`material`, `intensity`) come from a new optional shell-config field (default: absent — glass/whisper is fluidkit's own default character), NOT from BrandTokens. Unit tests: mapping correctness, radius parsing, knob defaulting.
- [ ] Mount `FluidThemeProvider` where the shell already applies brand theming so every element (page/overlay/slot) and every portal-rendered surface sits inside it. Verify portals: if OverlayPanel or toasts portal outside the provider subtree, mount the provider inside the portal root too. Tests: a fluidkit component rendered in each element picks up the brand accent.

### Task 2: Retire the loadFluidMotion() seam

Replacement table (each row = its own commit, tests updated in the same commit):

| Shell primitive | Replacement |
| --- | --- |
| `FluidThinking` | fluidkit `Thinking` imported directly; static-twin path deleted |
| `FluidRipple` | fluidkit `Ripple` imported directly; static-twin path deleted |
| `FluidReveal` | keeps its hand-rolled reveal, but imports `motion` + fluidkit's reduced-motion resolver statically; the lazy seam indirection is deleted |
| `ConnectTray` | same treatment as FluidReveal (static imports, seam deleted) |

- [ ] Apply the table; delete `fluid-motion.ts` and its tests once nothing imports it; reduced-motion behavior re-verified via the existing Playwright `reducedMotion` emulation tests.

### Task 3: Chrome migration (0.5-available surfaces only)

Surface-by-surface, one commit each, existing behavior tests stay green:

- [ ] `OverlayPanel` (overlay element + slot design view) → `LiquidPanel`/`LiquidDialog` as fits its modal/sheet role, brand-themed via provider (no per-callsite styling props).
- [ ] Tabbed page element (`FlowletPage`) tab strip → `LiquidTabs`.
- [ ] Primary action buttons (composer send, approval actions where visual parity allows) → `LiquidButton`; anything whose look regresses stays and is noted in the PR.
- [ ] Tooltips → `LiquidTooltip` where the shell has tooltips.
- [ ] Explicitly NOT migrated (deferred to 0.5.1 per spec): toasts (`FlowletToast`), menus/pickers (`IntegrationsPicker`), form controls. They keep brand CSS-var theming.

### Task 4: ENG-205 increment 3 — surface transitions

- [ ] Overlay enter/exit (Cmd+K): fluid morph via `MorphSurface`/LiquidPanel's own transitions; reduced-motion = instant.
- [ ] Tab switches in the page element: content cross-fade coordinated with LiquidTabs' indicator.
- [ ] Library card → tab (FlowGallery open): morph continuity between the card and the opened surface where feasible; plain fade where not (note which in the PR).

### Task 5: ENG-205 increment 4 — moment-of-consequence

- [ ] ApprovalCard materialization: entrance that reads as "something needs you" (fluidkit reveal/ripple vocabulary), calm by default, reduced-motion = instant.
- [ ] Automation toast moment: since LiquidToast is deferred, apply the motion treatment to the existing FlowletToast (entrance only, no component swap).

### Task 6: Verification + PR

- [ ] Full repo gates: `pnpm test`, `pnpm typecheck`, `pnpm lint`, dependency-guard test (fluidkit must be added to the runtime-dep allowlist consciously).
- [ ] Real-browser verification: demo-bank AND Cadence, each screenshotted across — default glass, `material: flat` config, dark-brand if a demo has one, and Playwright `reducedMotion` emulation. Screenshots go in the PR.
- [ ] Open the Flowlet PR (feature branch; never merge — Yousef reviews visuals per standing UI gate). PR body: screenshot matrix, the 0.5-tarball→npm swap note, deferred-surfaces list, ENG-205 inc.3/4 notes.

## Out of scope

- Toasts/menus/controls migration (0.5.1, after fluidkit's controls wave merges).
- Catalog (@flowlet/components), sandbox rendering, descriptors.
- fluidkit changes beyond consuming 0.5 (upstream gaps go to the findings doc).
