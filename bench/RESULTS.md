# Bench results

A full run captured on this machine. Regenerate with
`pnpm --filter @vendoai/bench bench -- --json` (deterministic) and the live
suites with keys sourced.

- **Date**: 2026-07-12
- **Machine**: Apple M4 Pro (12 cores), macOS 26.3, Node v24.2.0
- **Note**: a dev laptop is faster and quieter than a CI runner. Ceilings in
  `budgets.json` are seeded from these numbers with per-metric headroom that
  varies by scale (see the headroom column below and the budget philosophy in
  README.md); they get recalibrated against real CI samples once perf.yml has
  run on main a few times. Treat these numbers as the low-water mark.

## Deterministic suites (CI-gated)

Headroom = ceiling ÷ measured p95, rounded. Sub-millisecond metrics carry
absolute floors rather than a relative multiplier, which is why their headroom
is large — see README.md.

### tree-validate — `@vendoai/core` validateTree

| nodes | p50 (ms) | p95 (ms) | budget p95 | headroom |
| --- | --- | --- | --- | --- |
| 10 | 0.002 | 0.004 | 1 | ~250x (floor) |
| 100 | 0.007 | 0.012 | 1 | ~83x (floor) |
| 1000 | 0.061 | 0.077 | 3 | ~39x (floor) |
| 5000 (cap) | 0.220 | 0.425 | 6 | ~14x (floor) |

Validation is effectively linear in node count and sub-millisecond even at the
5000-node contract cap.

### tree-render — `@vendoai/ui` TreeView via renderToString (SSR)

| case | p50 (ms) | p95 (ms) | budget p95 | headroom |
| --- | --- | --- | --- | --- |
| render-10 | 0.48 | 0.66 | 4 | ~6x |
| validate+render-10 | 0.45 | 0.54 | — | not gated |
| render-100 | 0.64 | 0.88 | 6 | ~7x |
| validate+render-100 | 0.62 | 0.84 | — | not gated |
| render-1000 | 6.94 | 7.96 | 40 | ~5x |
| validate+render-1000 | 6.83 | 10.47 | — | not gated |
| render-5000 | 34.65 | 78.87 | 400 | ~5x |
| validate+render-5000 | 34.11 | 36.14 | — | not gated |

Render dominates validate — validation is a rounding error next to React SSR.
Render cost is roughly linear in node count; the 5000-node p95 is noisy (p50
~35ms, p95 wobbles between ~36ms and ~87ms across runs), which is exactly why
that ceiling is the widest.

### store — `@vendoai/store` on PGlite (temp dir), N=200

| op | p50 (ms) | p95 (ms) | budget p95 | headroom |
| --- | --- | --- | --- | --- |
| put | 0.16 | 0.26 | 4 | ~15x (floor) |
| get | 0.13 | 0.22 | 3 | ~14x (floor) |
| list (limit 20) | 0.42 | 0.57 | 5 | ~9x (floor) |

Postgres leg skipped (no `POSTGRES_URL` locally); it runs in CI against the
`postgres:16` service and is reported but not budget-gated.

### guard-call — 05 §2 decide → execute → report (PGlite-backed), N=200

| case | p50 (ms) | p95 (ms) | budget p95 | headroom |
| --- | --- | --- | --- | --- |
| call | 0.83 | 1.51 | 8 | ~5x |

Each call writes an audit row to PGlite, so this is the realistic guard-bound
wire-path cost, not just the policy decision.

### apps-api — `createApps` at the API seam (memory store), N=100

| op | p50 (ms) | p95 (ms) | budget p95 | headroom |
| --- | --- | --- | --- | --- |
| open | 0.11 | 0.21 | 3 | ~14x (floor) |
| call | 0.07 | 0.10 | 2 | ~21x (floor) |

`open()` includes validating the tree and resolving its query through the
guard-bound registry. HTTP-layer p95 gets added when the umbrella (09) lands.

### gen-scripted — `create()` engine overhead (scripted model), N=60

| op | p50 (ms) | p95 (ms) | budget p95 | headroom |
| --- | --- | --- | --- | --- |
| create | 0.09 | 0.17 | 3 | ~17x (floor) |

Everything `create()` does except the LLM — parse, validate tree, validate app
document, persist, audit — is ~0.1ms. The wall-clock of a real create is the
model round trip (below), not the engine.

## Live suites (never in CI)

Captured the same day on the same machine, from a separate keyed run.

### gen-live — real generation with `@ai-sdk/anthropic`, claude-sonnet-5, N=3

| metric | p50 (ms) | p95 (ms) |
| --- | --- | --- |
| stream-ttfb (direct streamText) | 918 | 932 |
| stream-total (direct streamText) | 19102 | 19123 |
| create-total (apps.create, buffered) | 9985 | 10140 |

- TTFB (~0.9s) is measured via a direct `streamText`, because the engine uses
  the non-streaming `generateText` — a first-token time is not observable at the
  `create()` seam.
- `create-total` (~10s) is the real engine-through-LLM latency; the engine's
  overhead (gen-scripted above) is ~0.1ms of it, i.e. the LLM is ~99.999% of the
  wall clock. The two totals are not directly comparable: `streamText` used a
  plain prose prompt (longer output), while the engine constrains the model to a
  JSON app document.
- `temperature`: the engine sends `temperature: 0`; `claude-sonnet-5` does not
  support it, and the `@ai-sdk/anthropic@2` client dropped the field with a
  warning (not a 400), so `create()` succeeded on sonnet-5. The fallback model
  path was therefore not exercised this run.

### e2b — real sandbox wake latency, N=5

| metric | p50 (ms) | p95 (ms) |
| --- | --- | --- |
| resume() | 317 | 380 |
| resume → first successful request | 371 | 472 |

**Verdict on the ~1s wake claim (06 §1 OpenSurface "resuming"): it HOLDS, and is
in fact conservative.** Measured resume→first-served p95 is **472ms** — roughly
half the ~1s the contract advertises. An e2b snapshot is a paused sandbox
(same id), so resume reconnects to a warm process and the in-sandbox HTTP server
answers within a couple hundred ms of unpausing. All sandboxes created were
snapshotted and killed on cleanup.
