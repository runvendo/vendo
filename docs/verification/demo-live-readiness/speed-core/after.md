# speed-core — AFTER evidence (fixed 8-prompt set, criteria 5-6) — CANONICAL: the AMENDED demo config

- Date: 2026-07-26 · harness: `SPEED_MODE=set` (representative demo-bank deps — see before.md) · engine includes ALL speed-core changes (island-repair-first ×2 shared-budget rounds, bounded worst case with the island-disclaim structured round, `full` pipeline events).
- **Amended demo config** (conductor ruling 2026-07-26): hosts set `apps.pipeline: { endPass: true }`; as the engine sees it from the runtime that is `{ endPass: false }` + defaults (the runtime owns endPass as its data-sighted verify — that extra runtime call is additive on top of these numbers). `SPEED_LABEL=after-amended` in `samples.ndjson`.

## Canonical table (amended config)

| prompt | class | first paint | pipeline stages | total | before (old ordering) |
|---|---|---|---|---|---|
| net-worth | happy | 1.24s | full | **9.3s** | 8.3s |
| subscriptions | happy | 0.62s | full, repair | **19.0s** | 13.1s |
| budgets | happy | 0.61s | full, repair | **26.7s** | 25.2s |
| goals-cashflow | happy | 1.31s | full, repair | **20.5s** | 22.8s |
| card-spending | happy | 1.55s | full, repair | **13.6s** | 40.4s |
| upcoming-bills | happy | 0.72s | full, repair | **12.3s** | 12.2s |
| fab-portfolio | fabricating-island | 0.82s | full, repair | **26.4s** | 33.4s |
| fab-fx | fabricating-island | 0.57s | full (single clean attempt) | **41.2s** | 32.3s |

All 8 succeeded; first paint p50 0.77s.

## Criteria verdicts (amended config)

- **#5 p50 create-complete ≤ 45s: PASS — 19.8s.** p95 (n=8 → max) ≤ 120s: **PASS — 41.2s.**
- **#6 fabricating prompt ≤ 2× happy-path p50 (32.6s this run):** fab-portfolio **PASS (26.4s)**; **fab-fx MISS (41.2s)** — parked per the ruling, see PARKED.md. The miss is NOT the multiplicative failure path the criterion targets: fab-fx validated on its FIRST full attempt with zero repair/retry activity (pipeline events: one `full`, valid) — it is one long clean generation, and the bound tightened because this run's happy p50 nearly halved (16.3s vs 31.4s in the prior run of the identical engine-visible config, where fab-fx passed at 32.5s vs a 62.8s bound).
- Corroborating run (`after-default` label — identical engine-visible pipeline, pre-checker engine code): p50 31.4s, max 50.8s, fab 23.5s/32.5s — **all thresholds pass**.

## Appendix — REJECTED config (pre-ruling `regionParallel: true`, label `after`)

| prompt | rejected fast config | dominant cost |
|---|---|---|
| net-worth | 73.0s | serial outline + island-repair rescue |
| subscriptions | 120.7s | assembly-invalid → full-ladder cascade |
| budgets | 33.3s | — |
| goals-cashflow | 45.8s | — |
| card-spending | 45.6s | — |
| upcoming-bills | 15.8s | — |
| fab-portfolio | 64.2s | island-repair rescue after slow sections |
| fab-fx | 148.5s | assembly-invalid → full-ladder cascade |

p50 55.0s / max 148.5s — missed #5 and #6 in two independent runs (second run archived in `samples-after-v1-nonrepresentative.ndjson`): the serial outline costs 8-14s before any section streams, and the `assembly-invalid` fallback re-enters the full single-stream ladder after ~30s of parallel work. This is why the ruling dropped `regionParallel` from the demo hosts. Follow-up backlog (not this lane): outline latency; island-style scoped rescue for non-island assembly failures.
