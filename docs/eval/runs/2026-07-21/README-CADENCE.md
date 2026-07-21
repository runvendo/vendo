# V4 FINAL GATE — Cadence half (scoring run, 2026-07-21)

Official v4-wave scoring run. One attempt per prompt, zero tuning, production boot
(`next start`, PORT=3200), main @ e6dbfe40 + gate branch `eval/v4-final-gate`
(candidate config: `pipeline: { promptRewrite: true, endPass: true }`, committed before
the first prompt; onPipeline server-log diagnostics). Auth: minted HS256 Supabase JWT
cookie (sub = Maya Alvarez seeded uuid). Prompts: C1–C15 (frozen 30) + F6–F10 (Tranche 2)
+ G6–G10 (Tranche 3, authored blind pre-gate).

Judge bar: docs/eval/GOLDEN.md PASS bar. Browser: dedicated headless Chromium (Playwright
1.61.1, 1440x900), same instance as the Maple half, one host booted at a time. Timing =
submit (Create click) → app visible (first rendered content, text-settle confirmed).
Screenshots taken after unclamping the workspace pane's scroll containers (capture aid
only). Repair + end-pass adoption read from the onPipeline server log.

## Results

| id | prompt | verdict | timing | class-if-fail | repair? | end-pass | note |
|----|--------|---------|--------|---------------|---------|----------|------|
| C1 | a client health dashboard: who's behind on documents | PASS | 32.5s | — | no | not applied | Stat row (8 of 12 clients behind, 21 outstanding / 38 received, nearest deadline Jul 23, 2026), 64% firm-wide progress bar, filterable/searchable missing-docs table with populated staff/entity selects, upcoming-deadlines table, live activity feed. No errors. Known wart persists: raw enums in cells (missing_docs, s_corp, sole_prop) despite design-rules asking for humanized labels. |
| C2 | show all clients with their assigned staff and deadlines | PASS | 7.9s | — | no | not applied | 12-client table, staff flattened to plain names (the object-cells trap avoided), formatted deadlines, docs received/total, status/staff/entity selects populated, search, sensible stat row (8 missing docs; nearest deadline Jul 23 / Blue Bottle Coffee). Raw-enum wart persists. |

## Summary

(run in progress)
