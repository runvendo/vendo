# Cadence extraction-fidelity findings (second real `flowlet init` customer)

- **Context:** Flowlet integration into `apps/demo-accounting` (Cadence). The extractor's first run was demo-bank (see `2026-07-02-flowlet-eng197-extraction-fidelity-findings.md`); this is the first run against an app the CLI was never tuned on.
- **Date:** 2026-07-02
- **Run:** `flowlet init apps/demo-accounting` (Anthropic key via Infisical, default `claude-sonnet-4-6`), output committed at `apps/demo-accounting/.flowlet/`
- **Detection:** framework `next`, tailwind `v4-css`, openapi found — all correct.
- **Never-modify guarantee:** held; `git status` showed only new files under `apps/demo-accounting/.flowlet/`.

## 1. Theme fidelity (`theme.json`, 30 vars scanned)

| Slot | Extracted | Ground truth (globals.css + usage) | Verdict |
|---|---|---|---|
| accent | `#0A7CFF` (DEFAULTED, flagged) | `#266755` (`--color-evergreen-600`, the primary button bg) | **Miss — known gap.** Cadence has an 11-step `evergreen` brand ramp but no var *named* accent/primary/brand, so the CLI defaulted. Correctly flagged for hand-edit. |
| background | `#fdf0df` (`--color-status-missing-bg`) | `#f7f5f1` (`--color-surface`, what `body` actually uses) | **Wrong pick.** The heuristic chose a *status tint* whose name contains "bg" over the var the body stylesheet actually consumes. Worst failure of the run: an amber page background. |
| surface | `#f7f5f1` (`--color-surface`) | `#ffffff` (`--color-card`, what Card renders on) | **Wrong pick — naming inversion.** In Cadence, `--color-surface` is the *page* background and `--color-card` is the elevated surface. Name-based mapping can't know that; usage analysis (what `body` vs `Card` consume) would. |
| text | `#221e19` (`--color-ink`) | `#221e19` | Exact. |
| mutedText | `#5B6470` (DEFAULTED) | `#5c554b` (`--color-ink-soft`) | **Miss.** `--color-ink-soft` / `--color-ink-faint` exist; neither matched the mutedText name heuristics. Coincidentally close to the real value, which makes it easy to not notice. |
| fontFamily | system stack (DEFAULTED) | `Hanken Grotesk` (`--font-sans: var(--font-hanken), …` via next/font) | **Miss — post-review hardening trade-off.** The var()-leak fix now defaults rather than carrying `var(--font-hanken)` (unresolvable in the sandbox). Right call for safety, but the *literal* family name is recoverable from the next/font import in layout.tsx. Improvement candidate. |
| radius | `8` (DEFAULTED) | `12px` (cards are `rounded-xl`; no CSS radius var exists) | **Unextractable from vars** — Cadence encodes radius in Tailwind utility classes only. Fair default, flagged. |
| mode | `light` | `light` | Exact. |

**Net: 2/8 slots correct.** Worse than the demo-bank run, and the interesting part is *why*: Cadence's tokens are semantically honest but unconventionally named (`surface` = page, `card` = surface), and both extracted color picks landed on the wrong var. Name heuristics degrade fast off the beaten path; the two improvement candidates are usage-tracing (what does `body`/the card primitive actually consume) and next/font literal recovery. All eight slots hand-fixed in the committed `theme.json`.

## 2. Tools fidelity (`tools.json`, deterministic OpenAPI path)

**11/11 operations extracted exactly** — names (from `operationId`), methods, paths, param + body schemas all match `openapi.json`. Annotations from HTTP semantics were right everywhere they could be: all GETs `mutating:false` (all genuinely read-only in this app), POSTs `mutating:true`, `reset_demo` caught as `dangerous:true` by the destructive-name list.

Hand-edits (committed):
1. `simulate_client_upload` → `dangerous: true`. It's demo choreography that fabricates client uploads + messages; nothing about the name or method reveals that. Spec-side `x-flowlet-dangerous: true` would be the durable fix.
2. Integration wiring (separate from these artifacts) excludes both `/api/demo/*` tools from the agent's toolset entirely — demo controls are for the demo driver, not the agent.

## 3. Component fidelity (`components/`, 8/23 wrapped, 15 excluded, 0 failed)

Wrapped: `Avatar`, `Badge`, `Button`, `CadenceLogo`, `CardHeader`, `ErrorState`, `ProgressBar`, `Skeleton`. All descriptors match `RegisteredComponent` (`source:"host"`), wrappers safeParse with the contained fallback, `entry.ts` fills the `window.__FLOWLET_HOST__` contract, `vite.config.mts` carries the post-review fixes (absolute entry, `publicDir:false`, re-rooted `@` alias).

- **Exclusion quality: genuinely good.** All 15 exclusions are correct with accurate reasons (SWR-fetching composites, ReactNode/LucideIcon props, router-coupled shells). `StatTile` — the component I most wanted — is *correctly* excluded (`value`/`sub` are ReactNode, `icon` is a component reference); wrapping it needs a redesigned JSON contract, i.e. a human.
- **The unstyled-wrapper trap, still open:** every wrapper imports the Tailwind-styled host component, and Tailwind CSS does not cross the sandbox CSP boundary — so all 8 render as bare HTML in real use. Known ENG-197 constraint, but nothing in the output warns about it. The `Badge`/`ProgressBar` wrapper impls in `.flowlet/` were hand-rewritten with inline styles as a first fix; after the brand tier (PR #25) landed mid-integration, the ACTUAL registration moved to the blessed 3-file path (`src/flowlet/host-components/` + `flowlet-sandbox/entry.ts` with `installFlowletHost({ css })` delivering the needed utility rules), which wraps the REAL app components. The `.flowlet/components/` tree stays as the reviewed extractor artifact (unwired).
- **Quality notes, repeating demo-bank's:** `Badge.variant` came back as open `z.string()` with the enum in prose (hand-fixed to `z.enum`); `className` escape hatches leaked on 4 wrappers (dropped on the wired `ProgressBar`).
- **New finding — primitive-name collision not flagged:** the wrapper named `Skeleton` collides with the stage's prewired `Skeleton` primitive. Resolution order happens to keep it functional (`source:"host"` bypasses the primitive table) but the model now sees two Skeletons. The demo-bank run renamed `Card`→`HostCard`; the collision list evidently covers the prewired catalog but not stage primitives.

- **New finding — `outDir` not re-rooted:** `vite.config.mts` re-roots the entry and the `@` alias "so the build works from any cwd", but leaves `outDir: "dist"` cwd-relative — built from the app root (the normal case), the bundle lands in the app's own `dist/`, not `.flowlet/components/dist/`. Hand-fixed alongside the merge wiring.

## 4. CLI DX findings

- **Unknown flags are silently swallowed and `init` runs anyway:** `flowlet init --help` printed no help — it ran a real extraction against the *current directory* (the monorepo root), writing a junk `.flowlet/` there (framework unknown, 0 tools). A CLI must never treat `--help` as "proceed with defaults".
- The per-slot provenance lines (`background <- --color-status-missing-bg`) made the theme review fast — that's the right output shape; it's what exposed both wrong picks immediately.

## 5. What needed hand-editing (consolidated)

1. `theme.json`: all of accent, background, surface, mutedText, fontFamily, radius (6 of 8 slots).
2. `tools.json`: `simulate_client_upload` → dangerous.
3. `components/Badge`: variant → `z.enum`; impl rewritten with inline styles (sandbox parity).
4. `components/ProgressBar`: `className` prop dropped; impl rewritten with inline styles.

Verification that the edited artifacts typecheck and the bundle builds lands with the integration itself (the app only gains the flowlet deps in that PR).
