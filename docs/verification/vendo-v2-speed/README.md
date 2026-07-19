# Vendo v2 generation speed — instrument + near-term wins

Lane: `yousefh409/vendo-v2-speed`. Goal bar: **<1s first paint / <10s complete**.
Owned (sub-second) serving is out of scope; this lane instruments the real
create path, lands the near-term BYO-API wins, and proves each with numbers.

## How to reproduce

The harness is a guarded live test (never runs in `pnpm test` — no keys, no
cost). Each `vitest run` is a fresh process, which is how cold vs warm is
measured honestly.

```bash
cp /Users/yousefh/orca/workspaces/flowlet/.env .env   # gitignored; never commit
set -a && . ./.env && set +a

# steady-state p50/p90 (connection warm after run 1)
SPEED_MODE=loop SPEED_RUNS=5 SPEED_VARIANT=two-lane \
  pnpm --filter @vendoai/apps exec vitest run src/engine.speed.test.ts

# cold (fresh process, no prewarm) vs warm (prewarm() then create)
SPEED_MODE=cold SPEED_VARIANT=two-lane pnpm --filter @vendoai/apps exec vitest run src/engine.speed.test.ts
SPEED_MODE=warm SPEED_VARIANT=two-lane pnpm --filter @vendoai/apps exec vitest run src/engine.speed.test.ts
```

Fixed prompt: a Maple net-worth dashboard against `apps/demo-bank/.vendo/catalog.json`.
Full model `claude-sonnet-4-6`, paint model `claude-haiku-4-5` (the demo defaults).
Raw samples land in `samples.ndjson` (gitignored); the table below is the aggregate.

## Instrumentation

`GenerationDependencies.onTiming` (opt-in, engine.ts) emits a structured
`GenerationTimingEvent` per lane: `first-partial` (time-to-paint) and
`complete` (with token usage), each `atMs` relative to `create()` start, plus a
`thinking` flag. Nothing is emitted unless a consumer wires `onTiming`.

## Numbers (ms, p50 / p90)

| Config | first paint p50 | first paint p90 | paint-complete p50 | complete p50 | complete p90 |
|---|---|---|---|---|---|
| single-lane (paint disabled) | 1265 | 2016 | — | **5643** | 10212 |
| two-lane, paint on **main** model (no fast paint) | 1100 | 2231 | 5142 | 11303 | 12665 |
| **two-lane, haiku paint (demo default)** | 1451 | 1785 | **4215** | 9903 | 10061 |
| two-lane haiku — cold (fresh process) | 1188 | 3842 | 3684 | 9291 | 11979 |
| two-lane haiku — warm (prewarm then create) | 1390 | 1674 | 3176 | 8372 | 12041 |

n=5 for loop rows, n=3–4 for cold/warm. Extended thinking is **off** on every
call (the codebase never enables it), so `thinking=false` throughout.

## The three near-term wins — honest assessment

**1. Skip the agent/tool loop for plain creates — already true, no change.**
`modelEngine.create` streams one wire generation via `streamText` with **no
tools** and no agentic round-trips (engine.ts). There is no tool loop to gate.
Confirmed by reading the path; number unaffected.

**2. Paint lane no-think + fast — already landed in the codebase.**
The paint lane already runs thinking-off (nothing enables thinking) on a fast
model (`claude-haiku-4-5`, demo default). Measured: first paint **p50 1.45s**
(beats the ~3s target) and a complete haiku screen at **p50 4.2s**. The task's
"~10s→~3s" framing assumed paint ran on the slow thinking model; it does not.
Data shows the fast paint model matters for *paint-complete* (haiku 4.2s vs the
main model 5.1s) but barely for first-partial (streaming yields a prefix in
~1–2s either way).

**3. Prewarm on page-open — implemented, but within noise; kept as a cheap guard.**
Added `runtime.prewarm()` + `prewarmModels()` (engine.ts): a best-effort,
never-throwing 1-token warm-up of the full + paint models on surface mount, so
the first create reuses a live connection. Measured effect on first paint is
**within API-latency variance** (cold p50 1188ms vs warm p50 1390ms). The first
paint floor is the model's time-to-first-token (~0.7–1.5s), which prewarm
cannot reduce; provider import + TLS is a few hundred ms lost in that noise.
Kept because it is cheap, harmless, and trims worst-case cold outliers — not a
headline win. **Wiring recipe:** call `vendo.apps.prewarm()` (or the runtime's
`prewarm()`) from the surface's mount effect / a lightweight route hit on
page-open.

## Key finding — the real remaining complete-time lever

The paint lane runs **sequentially before** the full lane (`create()` awaits the
paint stream, then runs the full stream). So two-lane `complete` ≈ paint (~4s) +
full (~6s) ≈ **9.9s**, whereas single-lane `complete` is **5.6s**. The paint
lane is not free on total time — it buys an early *complete* haiku screen at
~4.2s at the cost of ~4s on the final high-quality complete.

This is a genuine UX tradeoff, not strictly a regression: two-lane shows a
usable full screen at ~4.2s and upgrades in place at ~9.9s; single-lane shows
only a growing prefix until its final at ~5.6s. Running the two lanes
**concurrently** would cut two-lane complete toward ~5.6s while keeping the
early haiku screen, but it removes the `TIER0_LAYOUT` conditioning that keeps
node ids stable for the in-place swap (v2 spec §4) — a paint-lane/quality design
call, deliberately **not** changed in this lane. Flagged as the top follow-up.

## Gap to the bar

- **<10s complete: met.** Two-lane p50 9.9s (at the bar); single-lane p50 5.6s.
- **<1s first paint: not met.** p50 ~1.4s; the floor is model time-to-first-token.
  BYO-API cannot cross it — closing to sub-second needs **owned serving**
  (out of scope), the same conclusion the genui-bench work reached.

## What landed here

- `onTiming` structured timing seam (opt-in) around the create path.
- `runtime.prewarm()` / `prewarmModels()` best-effort page-open warm-up.
- `engine.speed.test.ts` repeatable live harness (guarded off the gate).
- This before/after report.

No change to create/paint/render behavior — the seams are additive and opt-in,
so the numbers above are the honest baseline the codebase already delivers.
