# Theme Pipeline Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (fresh subagent per task, two-stage review). Steps use `- [ ]` checkboxes.

**Goal:** One `BrandTokens` source drives one `--flowlet-*` CSS-var set (`brandToCssVars`) plus the OpenUI `Theme` (`mapBrandToTheme`), applied to both the host shell and the sandbox iframe, so brand themes every surface and nothing silently drops. Retire `--brand-*`.

**Architecture:** `BrandTokens → { brandToCssVars → --flowlet-* vars, mapBrandToTheme → OpenUI Theme }`, both applied host-side and inside the sandbox. `@flowlet/stage` stays decoupled from `@flowlet/components`: the OpenUI theme crosses into the iframe as an **opaque object** carried on the init payload, mounted by a **wrapper the host bundle exposes** (`window.__FLOWLET_THEME_WRAP__`); the runtime stays generic (injects a CSS-var map, mounts an opaque wrapper if present).

**Tech stack:** TypeScript, pnpm/turbo, vitest (unit), Playwright (stage gates), React, OpenUI (`@openuidev/react-ui`), Next.js (demo).

**Spec:** `docs/superpowers/specs/2026-07-02-flowlet-theme-pipeline-unification-design.md`. **Branch:** `yousef/eng-201-...` (this work lands in the ENG-201 PR).

**Verify commands:** `pnpm --filter @flowlet/components test`, `pnpm --filter @flowlet/stage test`, `pnpm --filter @flowlet/stage test:browser`, `pnpm --filter demo-bank test`, `pnpm build`.

---

## File map

| File | Change |
|---|---|
| `packages/flowlet-components/src/theme/brand-to-css-vars.ts` | **new** — `brandToCssVars(BrandTokens): Record<string,string>` (the canonical `--flowlet-*` producer, incl. derived border/shadow/skeleton) |
| `packages/flowlet-components/src/theme/*.test.tsx` | new unit tests for the mapping + derived values |
| `packages/flowlet-components/src/index.ts` | export `brandToCssVars` |
| `packages/flowlet-components/bundle/entry.ts` | expose `window.__FLOWLET_THEME_WRAP__` (mounts OpenUI `ThemeProvider` from the opaque `{theme,mode}` blob) |
| `packages/flowlet-stage/src/runtime.ts` | `Text`/`Skeleton` primitives read `--flowlet-*`; wrap the rendered tree in `__FLOWLET_THEME_WRAP__` when a `componentTheme` is present |
| `packages/flowlet-stage/src/runtime.test.ts` | marker tests updated (`--flowlet-*`, wrapper) |
| `packages/flowlet-stage/src/stage-host.ts` | `StageInitPayload` adds opaque `componentTheme?`; `theme` map is now `--flowlet-*`; carried through `initialize` |
| `packages/flowlet-stage/src/index.ts` | `ThemeTokens` doc updated (`--flowlet-*`) |
| `packages/flowlet-react/src/stage-adapter.tsx` | `FlowletStage` gains a `componentTheme?` prop, passed through to `initialize` |
| `apps/demo-bank/src/flowlet/brand.ts` | **new** — Maple's single `BrandTokens` |
| `apps/demo-bank/src/components/flowlet/SandboxStage.tsx` | compute `brandToCssVars(brand)` + `mapBrandToTheme(brand)`; pass `theme` + `componentTheme` to `FlowletStage` |
| `apps/demo-bank/src/components/flowlet/FlowletRoot.tsx` | apply `brandToCssVars(brand)` at the shell root + `FlowletThemeProvider brand`; drop ad-hoc `mapleTheme` |
| `packages/flowlet-stage/tests/browser/{fixtures/host.ts, gate-*.spec.ts}` | migrate `--brand-*`→`--flowlet-*`; add themed-custom-component gate + OpenUI-in-sandbox themed gate |
| `README.md` / `apps/demo-bank/README.md` | note the single theme pipeline |

---

## Task 1 — `brandToCssVars` generator (@flowlet/components)
**Files:** create `theme/brand-to-css-vars.ts` + test; export from `index.ts`.
- [ ] Write failing unit tests: each `BrandTokens` field maps to its `--flowlet-*` var per the spec table (accent/bg/surface/fg/fg-muted/radius/font 1:1; radius normalized to px); derived `--flowlet-border`, `--flowlet-shadow`, `--flowlet-skeleton` produced deterministically from the brand primitives; a full `defaultBrand` round-trips to a complete map.
- [ ] Run tests → fail (module missing).
- [ ] Implement `brandToCssVars` (pure; the sole owner of the derived-value formulas so host + sandbox never drift).
- [ ] Run tests → pass. Export from `index.ts`.
- [ ] Commit: `feat(components): brandToCssVars — canonical --flowlet-* generator`.

## Task 2 — stage primitives read `--flowlet-*` (retire `--brand-*` in runtime)
**Files:** `flowlet-stage/src/runtime.ts`, `runtime.test.ts`, `src/index.ts` (`ThemeTokens` doc).
- [ ] Update marker tests: runtime source contains `--flowlet-fg` / `--flowlet-skeleton`, not `--brand-text` / `--brand-skeleton`.
- [ ] Run → fail.
- [ ] Change `Text` (`--brand-text`→`--flowlet-fg`) and `Skeleton` (`--brand-skeleton`→`--flowlet-skeleton`) in `PRIMITIVES`; update the `ThemeTokens` doc comment to `--flowlet-*`.
- [ ] Run stage unit tests → pass.
- [ ] Commit: `refactor(stage): primitives read --flowlet-* (retire --brand-*)`.

## Task 3 — sandbox OpenUI theme wrapper (bundle + runtime, decoupled)
**Files:** `flowlet-components/bundle/entry.ts`, `flowlet-stage/src/runtime.ts` (+ marker test), `stage-host.ts` (`StageInitPayload.componentTheme?`).
- [ ] Bundle entry: set `window.__FLOWLET_THEME_WRAP__ = (blob, children) => <OpenUI ThemeProvider mode={blob.mode} lightTheme={blob.theme} darkTheme={blob.theme}>{children}</...>` (imports OpenUI's `ThemeProvider`, already bundled).
- [ ] Runtime: add marker test that the tree is wrapped via `__FLOWLET_THEME_WRAP__` when `currentParams.componentTheme` is set; run → fail; implement (in `buildElement`/`rerender`, if `componentTheme` present and the global exists, wrap the root element); run → pass. Stage stays generic — `componentTheme` is opaque (`unknown`).
- [ ] `stage-host.ts`: add `componentTheme?: unknown` to `StageInitPayload`; it already spreads the payload into `ui/initialize`, so it flows through. Add a unit assertion if a stage-host test exists.
- [ ] Commit: `feat(stage,components): mount OpenUI ThemeProvider in the sandbox via bundle wrapper`.

## Task 4 — pass `componentTheme` through `@flowlet/react`
**Files:** `flowlet-react/src/stage-adapter.tsx` + test.
- [ ] Failing test: `FlowletStage` with a `componentTheme` prop forwards it into `initialize`.
- [ ] Run → fail; add the `componentTheme?: unknown` prop and thread it into every `initialize` call (both generated + non-generated paths); run → pass.
- [ ] Commit: `feat(react): FlowletStage forwards componentTheme to the stage`.

## Task 5 — demo wiring: one Maple brand → shell + sandbox
**Files:** create `demo-bank/src/flowlet/brand.ts`; `SandboxStage.tsx`; `FlowletRoot.tsx`.
- [ ] Create Maple `BrandTokens` (`brand.ts`) — the demo's single brand.
- [ ] `SandboxStage`: import `brandToCssVars` + `mapBrandToTheme`; compute `theme = brandToCssVars(mapleBrand)` and `componentTheme = { theme: mapBrandToTheme(mapleBrand), mode: mapleBrand.mode ?? "light" }`; pass both to `FlowletStage`.
- [ ] `FlowletRoot`: apply `brandToCssVars(mapleBrand)` as inline CSS vars on the element wrapping the shell (overrides `styles.css` defaults for the subtree) and wrap in `FlowletThemeProvider brand={mapleBrand}`; remove the ad-hoc `mapleTheme` `FlowletTheme`.
- [ ] Verify `pnpm --filter demo-bank build` + `test` green.
- [ ] Commit: `feat(demo): single Maple brand feeds shell + sandbox theming`.

## Task 6 — migrate browser fixtures/gates + add themed gates
**Files:** `flowlet-stage/tests/browser/fixtures/host.ts`, existing `gate-render.spec.ts` / `gate-shared-react.spec.ts`, new gate spec.
- [ ] Migrate fixtures + the two gates from `--brand-*` to `--flowlet-*` (the injected theme map + assertions).
- [ ] Add a gate: a generated view with a custom-drawn component (e.g. `TimeOfDayClock` or a probe reading `--flowlet-accent`) reflects an **injected brand** color in the sandbox, not the hardcoded fallback (pins the silent-drop bug).
- [ ] Add a gate: an OpenUI catalog component (e.g. `Card`) rendered in the box reflects the brand `Theme` (proves the ThemeProvider mounts in the sandbox).
- [ ] Build bundles + run full browser suite → all pass (incl. the two new gates).
- [ ] Commit: `test(stage): brand themes custom + OpenUI components in the sandbox`.

## Task 7 — end-to-end verify + docs
- [ ] `pnpm build` (10/10); `pnpm test` (all green — orders.test.ts is fixed); `pnpm --filter @flowlet/stage test:browser` (all pass).
- [ ] Visual: render a branded view, screenshot; confirm shell chrome + sandbox content share one coherent brand.
- [ ] Docs: note the single theme pipeline (one `BrandTokens` → `--flowlet-*` + OpenUI Theme, both scopes) in the demo README; remove any stale `--brand-*` mention.
- [ ] Commit: `docs: single theme pipeline (BrandTokens → --flowlet-* + OpenUI)`.

---

## Notes / risks
- **Decoupling:** `@flowlet/stage` must NOT import `BrandTokens`/`@flowlet/components`. `componentTheme` is opaque on the stage side; only the host bundle (which bundles OpenUI) knows its shape. Keep it that way.
- **No drift:** `brandToCssVars` is the ONLY place `--flowlet-*` values (incl. derived) are computed; host and sandbox both call it. Do not re-derive elsewhere.
- **Back-compat:** the shell's `themeToStyle`/`FlowletTheme` stays for existing callers; the demo simply stops using the ad-hoc `mapleTheme` in favor of the one `BrandTokens`.
- **Out of scope:** extending `BrandTokens` primitives; the ENG-197 extractor; per-component theming beyond the shared set.
