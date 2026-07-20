# W4a — reliability pipeline: live measurement

Lane: `yousefh409/vendo-w4-pipeline`. Spec: v3 2-pager §How a generation runs.
Three engine-internal stages behind the GenerationEngine seam
(`packages/apps/src/engine.ts` + `packages/apps/src/pipeline.ts`):

1. **Structured repair** (default ON) — compile failures with a closed fix
   space are fixed by ONE strict tool-use call (flat schema, enums of real
   shape-card field paths / registry tools / payload skeletons, explicit
   `__no_valid_fix__` arm → Disclaimer/drop), spliced deterministically,
   re-compiled, re-validated. Max 2 rounds per create, then the free-form
   regeneration loop.
2. **Outline + region-parallel tier-2** (flag `pipeline.regionParallel`) —
   one strict outline call, N parallel per-section writers, deterministic
   assembly, whole-app validation; outline/coupling/assembly failures fall
   back to the single stream.
3. **End pass** (flag `pipeline.endPass`) — one no-think read-through emitting
   0–2 polish ops via `compileWirePatchV2`; invalid patches drop silently.

## How to reproduce

Guarded live harness (never runs in `pnpm test`):

```bash
cd packages/apps
set -a && . /Users/yousefh/orca/workspaces/flowlet/.env && set +a   # keys, gitignored, never commit
PIPE_MODE=run PIPE_VARIANT=baseline pnpm exec vitest run src/engine.pipeline.live.test.ts
PIPE_MODE=run PIPE_VARIANT=repair   pnpm exec vitest run src/engine.pipeline.live.test.ts
PIPE_MODE=run PIPE_VARIANT=parallel pnpm exec vitest run src/engine.pipeline.live.test.ts
PIPE_MODE=run PIPE_VARIANT=endpass  pnpm exec vitest run src/engine.pipeline.live.test.ts
```

10 fixed dev prompts against the demo-bank surface (catalog +
`.vendo/tools.json` + shape cards mirroring `src/server/types.ts`), full model
`claude-sonnet-4-6`, single lane (no paint consumer), thinking off. One run
per prompt per variant (2026-07-19). Raw samples land in `samples.ndjson`
(gitignored); the tables below are the aggregates.

## Numbers (n=10 prompts per variant, one run each)

| Variant | error-free | complete p50 | complete p95 | mean | validation incidents | post-first-failure recovery (median) |
|---|---|---|---|---|---|---|
| baseline (free-form loop) | 10/10 | 11 180 ms | 26 871 ms | 14 478 ms | 5/10 | **14 585 ms** [4.4s–19.4s] |
| **repair (new default)** | 10/10 | **9 946 ms** | 37 204 ms | **13 061 ms** | 4/10 | **6 850 ms** [1.4s–20.8s] |
| parallel (repair + region-parallel) | 10/10 | 23 012 ms | 51 424 ms | 28 337 ms | 4/10 | — |
| endpass (repair + end pass) | 10/10 | 14 108 ms | 45 390 ms | 16 712 ms | 4/10 | — |

### Structured repair (repair + endpass variants, 6 engagements)

| Metric | Value |
|---|---|
| Engaged (failure had a closed fix space) | 6 incidents |
| Fully fixed by the strict call (no regeneration) | 4/6 (67%) |
| Strict-round wall-clock per incident | 1.4s / 2.4s / 3.0s / 3.0s / 3.1s / 3.1s |
| Baseline free-form recovery for the same class | median 14.6s (one to two full regenerations) |
| `__no_valid_fix__` take-rate | 1 arm across 6 engagements (one field disclaimed) |
| Rounds per engagement | 1–2 (budget respected; misses escalate to the loop) |

Head-to-head on the prompts that failed in both runs: p3 (goals) baseline
13.7s/2 attempts → repair **11.6s/1 attempt** (3.1s structured fix); p4
(pay-a-scheduled-payment, missing-payload class) baseline 26.9s/3 attempts →
repair **9.0s/1 attempt** (1.4s structured fix filled the payload skeleton
from the tool input schema).

### Region-parallel (flagged OFF — honest result)

| Metric | Value |
|---|---|
| Fallback rate | 7/10 (5 `no-outline` — mostly single-region asks planned as 1 unit, which is correct; 2 `assembly-invalid`) |
| Ran parallel end-to-end | 3/10 (36.9s, 11.9s, 27.7s) |
| Outline call cost | 5.4s–8.9s per create (strict planning call, paid even on fallback) |
| Complete p50 | 23.0s vs 9.9s repair-only |

The machinery works as designed — coupled asks and failures never block, they
fall back to the single stream — but on today's BYO API it **hurts latency**:
the outline call is a 5–9s tax on every create, parallel sections each pay an
uncached prompt prefill, and one section can balloon (2 330 output tokens on
p0) so wall-clock ≈ outline + max(section) > one single stream. **Keeping
`regionParallel` flagged off.** To revisit: outline on the fast/paint model,
per-section output budgets, and prompt-cache pre-warm before the fan-out.

### End pass (stays opt-in via `pipeline.endPass`)

| Metric | Value |
|---|---|
| Ran | 10/10 creates |
| Applied a polish patch | 3/10 (retitles/dedupes that survived compile + re-validation) |
| Budget | p50 +1.9s, max +6.5s (task budgeted ~1s — over budget on sonnet-4-6; a haiku/no-think paint model is the intended host) |
| Broke anything | 0 (drops are silent; every shipped patch re-validated) |

## Honest notes

- One run per prompt per variant — p95 columns are dominated by single slow
  runs (p7, the cards prompt, swings 26–48s across variants from model
  variance, and its failure class — invalid prewired/host props — is outside
  the closed fix space in every variant).
- Structured-repair misses (p1, budgets prompt, twice): fixes were derived and
  applied but validation still failed after 2 rounds (a second, non-enumerable
  issue class remained), so ~3s was spent before the free-form loop recovered.
  The escalation path works; total time still beat baseline on that prompt.
- The error-free rate is 10/10 in every variant because the engine's
  compile-validate-repair loop already fails closed; what structured repair
  buys is **recovery time** (median 14.6s → 1.4–3.1s when the class is
  enumerable) and fewer whole-app regenerations (attempts p3: 2→1, p4: 3→1).
- Browser sanity (default config = structured repair on): one real generation
  on a prod-booted Maple host — see `browser-sanity.png`.
