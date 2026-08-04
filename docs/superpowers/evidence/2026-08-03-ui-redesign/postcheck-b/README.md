# Post-check round B — a11y / motion / center

Branch `redesign/postcheck-b`. Sixteen checker findings in the center, the
takeover, the split view and the chrome sheet, plus round C's H16 mechanism
adopted at its one site, plus one defect the merge exposed.

Everything below was produced by real Chromium on **port 3227** against the
shipped harness (`packages/ui/e2e/harness`), reduced-motion on (the settled state
axe can read honestly). The spec, the baseline spec and the config are copied in
beside the screenshots — `center.proof.spec.ts`, `shots.proof.spec.ts`,
`baseline-axe.proof.spec.ts`, `playwright.proof.config.ts` — so the run can be
repeated. They live outside `packages/ui/e2e` on purpose: that directory belongs
to round A this wave.

## axe — before / after

Baseline = `redesign/final-cleanup` (this round's parent), audited with the same
spec, same tags (`wcag2a wcag2aa wcag21a wcag21aa`), scoped to the center.

| surface | before | after |
| --- | --- | --- |
| desktop home (`/page-chat`) | 0 | 0 |
| desktop Apps grid | 0 | 0 |
| 390px, sheet closed | 0 | 0 |
| 390px, history sheet open | 0 | 0 |
| **Apps grid with a focusable planted in each tile preview** | **`aria-hidden-focus` ×3** | **0** |

The first four rows are the honest answer and the interesting one: **axe found
nothing before, because the harness's fixture apps render no interactive
furniture** — exactly ruling 17a's blind fixture. A real generated view has
buttons. The last row plants one `<button>` in each of the three tile previews
and asks again:

```
BASELINE H11 probe: {"tiles":3,"hidden":3,"inert":0,"reachable":3} → aria-hidden-focus x3
AFTER    H11 probe: {"tiles":3,"hidden":0,"inert":3,"reachable":0} → none
```

`reachable` is the browser's own answer to `element.focus()` — before, every
planted control took focus inside a subtree screen readers had been told to
ignore; after, `inert` refuses all three. The unit fixture
(`test/chrome/center.test.tsx`) now renders a Button inside the app surface too,
so the class cannot come back silently.

Two other finding families are invisible to axe by construction and are measured
directly in the browser instead:

- **M33 (WCAG 1.4.11, non-text contrast)** — axe's `color-contrast` rule only
  covers text. `center.proof.spec.ts` computes the real ratio of each indicator
  against its own ground; every one clears 3:1.
- **M29 / M19 (motion)** — asserted on the emitted sheet
  (`test/chrome/s1-recipe.test.ts`), since a media query is not observable from a
  single audited state.

## Screenshots

| file | what it shows |
| --- | --- |
| `b-h10-activity-recovery.png` | ··· → Activity → ··· (closed): a tab stop survives, the panel still has a name |
| `b-h18-keyboard-walk.png` | after ArrowUp/ArrowUp/ArrowDown/Home/End on the rail — Apps still selected, the conversation and its draft intact |
| `b-m34-sheet-focus.png` | the mobile history sheet holding focus (12 Tabs never leave it) |
| `b-h11-inert-tiles.png` | the Apps grid with inert previews |
| `b-mobile-sheet.png` · `b-desktop-apps-grid.png` | the two axe-audited states |
| `b-m33-before-rail.png` → `b-m33-after-rail.png` | the open conversation and the selected row, before/after the 3:1 indicator |
| `b-m33-before-apps-grid.png` → `b-m33-after-apps-grid.png` | tile edges, before/after |
| `b-m33-before-mobile-head.png` → `b-m33-after-mobile-head.png` | the mobile section indicator, before/after |
| `b-m33-indicators-desktop.png` | the measured desktop state |
| `b-m33-after-automations-switch.png` | the automations panel (the OFF track is pinned in `panels.test.tsx`; this fixture's automation is enabled) |

`browser-proof.log` is the full run: 11 passed.

## Gates

Convention per `../gates/README.md` (forced, serial, `Cached:` line kept). Logs
in `gates/`.

| log | command | result |
| --- | --- | --- |
| `gates/build.log` | `pnpm build --force` | 24/24 · `Cached: 0 cached, 24 total` · 48.1s · `EXIT=0` |
| `gates/typecheck.log` | `pnpm typecheck --force` | 43/43 · `Cached: 0 cached, 43 total` · 30.5s · `EXIT=0` |
| `gates/ui-test.log` | `pnpm --filter @vendoai/ui test` | 99 files / 891 tests passed · `EXIT=0` |
| `gates/lint.log` | `pnpm exec turbo run lint --force` | 6/6 · `Cached: 0 cached, 6 total` · 12.4s · `EXIT=0` |

The root `pnpm test` suite was deliberately NOT run: sibling rounds were building
on the same laptop, and round C's wave-level `gates/test.log` covers that target.

## Test edits, called out

Three, all defect-pinning or mechanical:

1. `center.test.tsx` "keeps roving tab semantics" — asserted that an arrow key
   ACTIVATED the row it landed on, i.e. it pinned H18's destructive behavior as
   the contract. Rewritten to focus-without-activation; a new case proves the
   open conversation survives an ArrowUp.
2. `workspace-palette-slot.test.tsx` — the same pin, same rewrite.
3. `mobile-takeover.test.tsx` — two `getByRole("main", …)` lookups became
   `getByRole("region", …)`: the same element, correctly typed after H12 stopped
   emitting a second `<main>`.

Plus one refinement: `s1-recipe.test.ts`'s "exactly one animation while a card
builds" scan counted `animation: none` as an animation, so M19's suppression rule
read as a second loop. It now excludes suppressions; the law it pins is unchanged.
