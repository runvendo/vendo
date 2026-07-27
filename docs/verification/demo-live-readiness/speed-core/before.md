# speed-core — BEFORE baseline (fixed 8-prompt set)

- Date: 2026-07-26 · harness: `packages/apps/src/engine.speed.test.ts` `SPEED_MODE=set SPEED_LABEL=before`
- Deps: representative demo-bank surface (`src/bench/demo-bank-surface.ts` — catalog + tools + shape cards), two-lane (paint `claude-haiku-4-5`, full `claude-sonnet-4-6`, direct `ANTHROPIC_API_KEY`), prewarmed.
- Pipeline config: **default** — `structuredRepair` on, `regionParallel` OFF, `endPass` OFF (what the pre-demo-refresh hosts ran); island-repair ordering as shipped (after a full-lane attempt only, 1 round).
- Prompts: `prompts.json` (6 happy Maple + 2 fabricating-island class). Raw events: `samples.ndjson` (label=before).

| prompt | class | first paint | paint complete | full attempts | full complete (per attempt) | structured repair (rounds/fixed/ms) | total |
|---|---|---|---|---|---|---|---|
| net-worth | happy | 0.68s | 2.7s | 1 | 8.3s | — | **8.3s** |
| subscriptions | happy | 0.61s | 2.7s | 1 | 10.7s | 1/yes/2.4s | **13.1s** |
| budgets | happy | 0.96s | 6.5s | 1 | 22.4s | 1/yes/2.7s | **25.2s** |
| goals-cashflow | happy | 1.37s | 5.5s | 1 | 20.2s | 1/yes/2.6s | **22.8s** |
| card-spending | happy | 0.95s | 3.2s | 2 | 16.4s, 36.4s | 1/no/2.2s + 1/yes/4.0s | **40.4s** |
| upcoming-bills | happy | 0.55s | 3.0s | 1 | 10.6s | 1/yes/1.5s | **12.2s** |
| fab-portfolio | fabricating-island | 0.59s | 2.5s | 1 | 28.5s | 1/yes/5.0s | **33.4s** |
| fab-fx | fabricating-island | 0.60s | 2.4s | 1 | 27.9s | — | **32.3s** |

## Aggregates (before)

- create-complete: **p50 24.0s**, worst 40.4s (n=8, all succeeded)
- happy-path p50: **17.9s** · fabricating-island: 33.4s / 32.3s (1.9× / 1.8× happy p50)
- first paint: p50 0.63s, worst 1.37s
- island-repair stage events: **0** — none of the live failures in this run were island-only (they were binding/query-tool classes, fixed by structured repair). The island-repair-first pathology (5-9 min creates) is a failure-class event, unit-covered by criteria 1-3; this table is the config/speed half of the evidence.

## Notes

- A FIRST run of this harness with catalog-only deps (no `tools`/`toolShapes` — the harness's historical shape) had every prompt failing validation with invented tool references and an EMPTY structured-repair fix space: archived in `samples-invalid-catalog-only.ndjson` as the reason set mode runs the representative surface.
- `maxRetries: 0` everywhere — no hidden retry amplification; timings are single-call honest.
