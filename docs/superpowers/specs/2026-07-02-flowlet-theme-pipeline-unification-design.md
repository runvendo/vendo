# Flowlet theme pipeline unification (Design)

- **Issue:** ENG-201 item 3 (post-one-box cleanup — theme var mismatch). Full pass.
- **Date:** 2026-07-02
- **Status:** Design approved in brainstorming (Q1–Q3 locked with Yousef). Pending spec review.
- **Builds on:** one-box (ENG-200). **Feeds:** ENG-197 (theme extractor), ENG-187 (component library).

## 1. Problem

Three parallel theme mechanisms coexist and disagree on names, coverage, and scope, so a component is themed by whichever one its author happened to reach for — and in the actual one-box render path, generated UI in the sandbox is effectively un-themed:

- `--flowlet-*` — the shell's rich chrome token set (`flowlet-shell/styles.css`), living in the **host page**. `TimeOfDayClock` (a catalog component) reads these but renders in the **sandbox**, where they are not produced, so it silently falls back to hardcoded colors.
- `--brand-*` — a tiny ad-hoc set (`primary/surface/text/skeleton`) meant for the **sandbox**; read by stage primitives + host components.
- OpenUI `Theme` — a React-context object (`mapBrandToTheme`) for OpenUI-based catalog components; not CSS vars.

Verified gaps in the live path: `SandboxStage` passes **no** `theme` to the stage (so no brand vars are injected into the iframe at all), and `FlowletThemeProvider` (OpenUI's context) is mounted only on a home-page card, **not** in the sandbox bundle (so catalog components in the box get OpenUI's default theme). The pipeline is not connected end-to-end.

`BrandTokens` (`@flowlet/components/theme/brand.ts`) is the intended single source of truth (8 serializable primitives: accent, background, surface, text, mutedText, fontFamily, radius, mode) and is what ENG-197's extractor will produce.

## 2. Decisions (from brainstorming)

- **Q1 — one source, two derived outputs (A).** Everything derives from `BrandTokens`. The unified layer is a single canonical CSS-variable set; OpenUI `Theme` remains a sibling derived artifact (keep `mapBrandToTheme`, do not fight OpenUI's context theming).
- **Q2 — canonical prefix `--flowlet-*` (A).** Retire `--brand-*`. `BrandTokens` maps near 1:1 onto the shell's existing `--flowlet-*` names, and `TimeOfDayClock` already reads `--flowlet-*`, so it is fixed for free once those vars are produced in the sandbox. Migrate the smaller `--brand-*` consumer set.
- **Q3 — full end-to-end wiring (A).** Not just a rename: actually carry brand to where components render (host page + sandbox), including mounting OpenUI's `ThemeProvider` in the sandbox. Outcome: brand themes every surface; nothing silently drops.

## 3. Architecture

```
BrandTokens ──┬─ brandToCssVars() → --flowlet-* CSS vars ─┬─ host page (shell root)
              │                                            └─ sandbox iframe (injected)
              └─ mapBrandToTheme() → OpenUI Theme ─────────┬─ host (FlowletThemeProvider)
                                                           └─ sandbox (ThemeProvider in bundle)
```

One source of truth, two derived artifacts (CSS vars + OpenUI Theme), both applied in both scopes. No consumer reads a var/context not produced in its scope.

## 4. The generator + canonical token set

New pure function `brandToCssVars(brand: BrandTokens): Record<string, string>` in `@flowlet/components/theme`, alongside `brand.ts` / `map-brand-to-theme.ts`. It produces the **component-facing** `--flowlet-*` set:

| CSS var | Source |
|---|---|
| `--flowlet-accent` | `brand.accent` |
| `--flowlet-bg` | `brand.background` |
| `--flowlet-surface` | `brand.surface` |
| `--flowlet-fg` | `brand.text` |
| `--flowlet-fg-muted` | `brand.mutedText` |
| `--flowlet-radius` | `brand.radius` (normalized to px) |
| `--flowlet-font` | `brand.fontFamily` |
| `--flowlet-border` | derived (low-alpha mix of `text`/`surface`) |
| `--flowlet-shadow` | derived (from `text` at low alpha) |
| `--flowlet-skeleton` | derived (low-alpha `text`) — replaces `--brand-skeleton` |

The shell's purely-chrome tokens (`--flowlet-glass/blur/danger/ok` and the `light-dark()` defaults) stay in `styles.css`; they already reference the brand vars via `color-mix`, so they update automatically when the brand set is applied. `styles.css` remains the unbranded baseline (defaults); an applied brand overrides the brand subset.

**Derived-value definitions are owned by `brandToCssVars`** so the host and the sandbox produce identical values from the same input.

## 5. Wiring brand through both scopes

- **One brand source in the demo.** Maple defines a single `BrandTokens` and feeds all consumers, replacing the ad-hoc `mapleTheme` (`FlowletTheme`) and the currently-absent sandbox theme.
- **Host page (shell).** The shell root applies `brandToCssVars(brand)` as inline CSS vars (overriding `styles.css` brand defaults) and wraps content in `FlowletThemeProvider brand={brand}` for any in-process OpenUI usage.
- **Sandbox.** Derivation happens host-side (where `@flowlet/components` is importable): `SandboxStage` computes `brandToCssVars(brand)` and `mapBrandToTheme(brand)` and passes both into the stage via the init payload. Inside the iframe:
  - the stage runtime injects the `--flowlet-*` vars (it stays generic — just applies a CSS-var map);
  - the sandbox host bundle exposes an OpenUI `ThemeProvider` wrapper that the runtime mounts around the rendered tree, fed the passed OpenUI `Theme`, so catalog components in the box theme.
- **Stage payload change.** `StageInitPayload` replaces the old `theme: Record<string,string>` (`--brand-*` map) with the `--flowlet-*` var map plus a serializable OpenUI `Theme` for the bundle's provider. `ThemeTokens` in `@flowlet/stage` updates accordingly. The exact runtime↔bundle wrapper mechanism (a bundle-exposed provider the generic runtime mounts) is an implementation detail for the plan; the contract is: brand vars injected + OpenUI Theme context mounted, both from one `BrandTokens`.

## 6. Migration of `--brand-*` (bounded)

Migrate to `--flowlet-*`: stage `Text` (`--brand-text`→`--flowlet-fg`) and `Skeleton` (`--brand-skeleton`→`--flowlet-skeleton`) primitives (`runtime.ts`); the sample-bundle `Card` fixture; the theme-injection path + `ThemeTokens` type; the browser gates asserting `--brand-primary` (`gate-render`, `gate-shared-react`, and the `host.ts` fixtures). `TimeOfDayClock` is unchanged (already reads `--flowlet-*`).

## 7. Testing

- **Unit (`@flowlet/components`):** `brandToCssVars` maps each `BrandTokens` field to the correct var and produces the defined derived values; round-trips a full brand. `mapBrandToTheme` unchanged (existing tests stay green).
- **Stage browser gate (the regression guard):** a generated view with a custom-drawn component (`TimeOfDayClock` or a probe reading `--flowlet-accent`) renders in the sandbox and reflects an **injected brand** color, not the hardcoded fallback. This directly pins the silent-drop bug.
- **OpenUI-in-sandbox gate:** a catalog component (e.g. `Card`) rendered in the box reflects the brand `Theme` (a brand-derived color is applied), proving the ThemeProvider is mounted in the sandbox.
- **Shell:** the shell root carries the brand vars; existing shell tests stay green.
- **Visual:** render a branded view end-to-end, screenshot, confirm shell chrome and sandbox content share one coherent brand look.

## 8. Out of scope / follow-ups

- No new brand *primitives* beyond the current `BrandTokens` (ENG-187/197 may extend the schema later; this unifies the pipeline for the existing set).
- The ENG-197 extractor that *generates* `BrandTokens` from a host codebase is a separate issue; this establishes the single target it writes to.
- Per-component fine-grained theming beyond the shared token set is not introduced.
