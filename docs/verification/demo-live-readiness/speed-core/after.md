# speed-core — AFTER evidence (fixed 8-prompt set, criteria 5-6)

- Date: 2026-07-26 · harness: `SPEED_MODE=set` (representative demo-bank deps — see before.md) · engine includes the speed-core changes (island-repair-first ×2 rounds, bounded worst case).
- Raw events: `samples.ndjson` (labels `before`, `after` = faithful demo config, `after-default` = default pipeline). An earlier non-faithful fast run (endPass in-engine, no exemplarContract) is archived as `samples-after-v1-nonrepresentative.ndjson`.
- "Faithful demo config" = what the demo hosts hand the engine: `{ exemplarContract: true, structuredRepair: true, regionParallel: true, endPass: false }` (the runtime owns endPass as its data-sighted verify; the engine's blind end pass never runs in a real demo create — that runtime verify call is additive on top of these numbers).

## Per-prompt totals (ms → s)

| prompt | class | before (default, old ordering) | after (FAST demo config) | after-default (default, new ordering) |
|---|---|---|---|---|
| net-worth | happy | 8.3s | 73.0s | **9.2s** |
| subscriptions | happy | 13.1s | 120.7s (assembly-invalid → full ladder) | **32.4s** |
| budgets | happy | 25.2s | 33.3s | **43.2s** |
| goals-cashflow | happy | 22.8s | 45.8s | **30.4s** |
| card-spending | happy | 40.4s | 45.6s | **50.8s** |
| upcoming-bills | happy | 12.2s | 15.8s | **12.8s** |
| fab-portfolio | fabricating-island | 33.4s | 64.2s | **23.5s** |
| fab-fx | fabricating-island | 32.3s | 148.5s (assembly-invalid → full ladder) | **32.5s** |

All 24 runs succeeded (no failed creates). First paint p50 ≈ 0.6-1.4s in every configuration (two-lane paint is untouched by the pipeline flags).

## Criteria verdicts

| criterion | fast demo config (`after`) | default pipeline (`after-default`) |
|---|---|---|
| #5 p50 create-complete ≤ 45s | **55.0s — MISS** | **31.4s — PASS** |
| #5 p95 (n=8 → max) ≤ 120s | **148.5s — MISS** | **50.8s — PASS** |
| #6 fabricating prompt ≤ 2× happy p50 | fab-fx 148.5s vs 91.4s — **MISS** (fab-portfolio 64.2s passes) | 23.5s / 32.5s vs 62.8s — **PASS** |

Two independent fast-config runs missed (the archived v1 run: p50 50.8s, max 107s, fab-portfolio 107s), so this is not single-run flake.

## Dominant-stage analysis (why the fast config misses)

1. **The outline is a serial prefix.** Region-parallel spends 8-14s on the outline call before any section streams; on this catalog most apps need 2-3 sections whose parallel wins don't repay the outline cost. (Timing events: `outline complete` at 8.3-14.3s in every `after` sample.)
2. **`assembly-invalid` fallback is a cliff, and it multiplies the fabricating class.** When the assembled sections fail validation with NON-island issues, the engine falls back to the full single-stream ladder — after ~30s already spent in parallel. subscriptions (120.7s) and fab-fx (148.5s) both walked this path: parallel ~30s → full ladder with repairs. This is the same multiplicative shape the island fix killed, one layer up.
3. **Island-repair-first works and is visible live**: `budgets`/`net-worth`/`fab-portfolio` in the `after` runs were rescued by `island-repair` events (region-parallel assembly rescue), and in `after-default` the fabricating prompts dropped from the worst rows to the BEST rows (23.5s / 32.5s) — the failure path is no longer multiplicative at the island layer.
4. The engine end pass (v1 run) added 1.4-2.2s and rarely applied; moot in real demos (runtime suppresses it) but worth knowing for engine-level benchmarks.

## Recommendation (for the conductor — not applied; criterion pinned to the fast config)

The speed goal is met by the engine-side fixes with the DEFAULT pipeline; `regionParallel` as shipped makes the demos slower, not faster, on this surface. Either drop `regionParallel: true` from the demo hosts' pipeline block, or fund a follow-up on the two dominant costs (outline latency; island-style scoped rescue for non-island assembly failures instead of the full-ladder fallback).
