# gen-fidelity: theming & fidelity — execution plan

> Workstream 3 of `docs/superpowers/specs/2026-07-14-ui-generation-design.md` (approved, locked).
> Linear: ENG-242 (workstream) + ENG-244 (jail height bug). Orchestrator: gen-fidelity session; execution by codex sol workers, one Orca worktree per task.

**Goal:** generated UI passes the designer-squint test on Maple + Cadence — full theme extraction, dark mode end-to-end, brand-derived palette, branded primitives, and fidelity prompt rules — plus the jail auto-height fix.

**Grounding found during scoping (2026-07-14):**

- The frozen `VendoTheme` contract (`packages/core/src/catalog.ts`) already has every slot we need (border, danger, accentText, headingFamily, density, motion) — extraction simply never fills them; `map-to-brand.ts` maps only 8 slots and drops `darkScope` vars on the floor.
- The zod schema is `.passthrough()`, so dark pairs and the derived palette can ride as additive optional keys without breaking the frozen contract — needs parent ack before merge (contract-adjacent).
- Jail height bug is a feedback ratchet: inner html/body pinned to `height:100%`, parent sets outer iframe height from `documentElement.scrollHeight` resize messages, each write raises the next measurement to the 8192 cap. Fix by measuring content (the mount), not the viewport-pinned document.
- Prompt fidelity rules land in the engine prompt (`packages/apps/src/engine.ts`), which gen-streaming (slimming) and gen-catalog (catalog section) also edit — sequencing must go through the parent.

## Waves

**Wave 1 — parallel, disjoint file zones (3 workers):**

1. **T1 / ENG-244 — jail auto-height fix.** Zone: `packages/ui/src/tree/jail/*`. Diagnose the resize ratchet, fix height reporting so the iframe hugs content, regression-test, verify in browser on demo-bank ("build me a budget tracker") with before/after screenshots. Small standalone PR.
2. **T2 — extraction widening + Maple misses.** Zone: `packages/vendo/src/cli/theme/*`, `packages/vendo/src/cli/init.ts`. Fill all VendoTheme slots; fix measured Maple misses (Inter extracted as system-ui, 8px radius as 14px, accent `#0A7CFF` vs host black). Corpus harness (`pnpm corpus`) must not regress; report new slot accuracy on Maple + Cadence.
3. **T3 — branded primitive kit v1.** Zone: `packages/ui/src/tree/primitives.tsx` (+ sibling file), `packages/ui/src/theme.ts`. Exactly 8: Card, Button, Input, Select, Table, Badge, Stat, Tabs — token-themed via `--vendo-*` vars, rendered outside the jail, registered in `PREWIRED_COMPONENTS`. Browser-verified on both demos.

**Wave 2 — after T2 merges (2 workers):**

4. **T4 — dark mode end-to-end.** Extraction keeps light+dark pairs → additive `dark` key in theme.json → CSS vars flip with host dark mode → jail `applyThemeVars`. Spans theme CLI + `packages/ui/src/theme.ts` + jail. Parent ack on the additive contract shape before merge.
5. **T5 — derived extended palette.** Derivation (brand-harmonized data-viz series + status tints from extracted brand) in the theme CLI; exposed as `--vendo-palette-*` vars into chrome-adjacent tree surfaces and the jail. The palette is the escape hatch — no bare hard lint.

**Wave 3 — after parent coordinates the engine-prompt zone (1 worker):**

6. **T6 — prompt fidelity rules.** No emoji (hosts use zero), host icon conventions, density matching, constrain generated styling to theme vars + palette, teach the model the 8 branded primitives. One coordinated PR into `packages/apps/src/engine.ts` sequenced against gen-streaming/gen-catalog prompt edits.

**Final gate:** squint-test screenshots (light + dark) on Maple + Cadence sent to parent; feeds gen-verify's corpus montage.

## Decisions locked by the spec (do not re-litigate)

- Palette constraint instead of hard lint; kit is exactly 8 primitives; dark mode is in scope; density/motion/emoji rules are in scope; tiering/full design-system inference are out.

## Coordination ledger

- Engine prompt (`packages/apps/src/engine.ts`): parent ruled the sequence — gen-streaming slims first, gen-catalog's section second, our T6 last; hold T6 until parent signals catalog merged.
- Never touch `packages/ui/src/chrome/*` or `chrome-css.ts` (block-ui's zone).
- `packages/ui/src/theme.ts` is COORDINATED-SHARED (parent ruling 2026-07-14): announce every touch to the parent BEFORE editing; block-ui's ENG-226/ENG-227 land there too. T3's additive derived density/motion vars announced. `themeCssVariables` changes must reference ENG-227.
- **T4 binding design (parent ruling):** block-ui ENG-226's luminance-of-background scheme derivation is the DEFAULT; our extracted dark pairs are an OVERRIDE layer on top, not a parallel mechanism; the pipeline exposes ONE canonical scheme signal, consumed by chrome via `color-scheme`. Carry this into T4's dispatch as an addendum.
- Contract-adjacent additions (dark pair, palette key on theme.json): flag to parent with proposed shape before the T4/T5 PRs merge.
- Null-render fix (gen-streaming handoff) folded into T1/ENG-244: explicit null-render signal + ContainedNotice fallback; cross-link their edit-reliability PR. gen-streaming contact (final, after split-brain fix): term_16710c94-9281-46bf-853a-0ffc6b974523.
- block-ui orchestrator contact: term_08257df7-5b8f-42b7-baa9-a30be13d1675; their ENG-223 child announces before touching tree PinMount/frames.

## Per-PR bar (every task)

`pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; real-browser screenshots for UI-affecting changes; branch + PR, never main.
