# @vendoai/bench

The permanent performance-budget gate and honest latency measurements for the
Vendo v0 blocks. Private (never published). Speed is the product thesis; this
package turns that into a CI check and a set of reproducible numbers.

Everything lives under `bench/`. It touches no contract file and no other
package's source. It participates in the root turbo gates, but its `test`
script runs only fast unit tests of the harness itself — the actual benchmark
run is a separate explicit command.

## Layout

- `src/stats.ts` — percentile math (p50/p95, linear-interpolation R-7), warmup +
  measurement loop.
- `src/budgets.ts` — load `budgets.json`, compare measured p95 against ceilings.
- `src/report.ts` — JSON envelope, markdown tables, terminal summary.
- `src/trees.ts` — synthetic `vendo-genui/v1` tree generator (exact node counts,
  realistic props, `$path`/`$state` bindings, ≤16 queries).
- `src/fixtures/` — minimal replicas of the `@vendoai/apps` testing fixtures
  (scripted model, memory store, tool registry). Those fixtures are not exported
  via a package subpath, so they are re-implemented here rather than imported.
- `src/benches/*` — one file per suite; `src/run.ts` — the CLI.
- `demo-capture/` — README and gitignored output for the four UI-generation
  demo GIF beats; the TypeScript capture driver lives in `src/demo-capture/`.
- `demo-creator/PLAYBOOK.md` — the creator-agent contract for generating
  per-prospect demos (`demo:create` / `demo:research`, implemented in
  `src/demo-creator/`; verified via `demo:capture -- demo-beats`).
- `budgets.json` — the permanent gate thresholds.
- `RESULTS.md` — a full captured run (deterministic + live) from a real machine.

## Running

```sh
# From the repo root. Deterministic suites only (the default):
pnpm --filter @vendoai/bench bench

# One suite, JSON output, or the budget check:
pnpm --filter @vendoai/bench bench -- --suite tree-render
pnpm --filter @vendoai/bench bench -- --json
pnpm --filter @vendoai/bench bench -- --check      # exits 1 on any breach

# Live suites (never in CI; require keys). "all" also runs deterministic:
source /path/to/flowlet/.env         # ANTHROPIC_API_KEY, E2B_API_KEY
pnpm --filter @vendoai/bench bench -- --suite gen-live
pnpm --filter @vendoai/bench bench -- --suite e2b
```

The build must be current (`pnpm build`) — the CLI runs from `dist/`.

## Suites

Deterministic (CI-gated):

| Suite | Measures |
| --- | --- |
| `tree-validate` | `@vendoai/core` `validateTree` at 10 / 100 / 1000 / 5000 nodes (5000 = the 01 §8 cap). |
| `tree-render` | `@vendoai/ui` `TreeView` via `react-dom/server` `renderToString`; render-only and validate+render per size. Prewired primitives only, so no jsdom is needed. |
| `store` | `@vendoai/store` on PGlite (temp dir): record `put`/`get`/`list`, N=200. Also runs the Postgres leg when `POSTGRES_URL` is set (the 02 gating convention); the Postgres leg is not budget-gated. |
| `guard-call` | `createGuard` over PGlite, `guard.bind()` a no-op registry, N calls through the bound registry — the 05 §2 decide → execute → report choke point, with an audit row written per call. |
| `apps-api` | `createApps` (memory store + guard-bound registry + scripted model): `open()` and `call()` p50/p95. Measured at the API seam — the HTTP wire routes (09) live in the umbrella built in a parallel wave and get added when it lands. |
| `gen-scripted` | `create()` total latency with the scripted model — deterministic engine overhead only (parse → validate → persist → audit), no LLM. |

Live-gated (never in CI; skip cleanly with a printed reason when the key is absent):

| Suite | Key | Measures |
| --- | --- | --- |
| `gen-live` | `ANTHROPIC_API_KEY` | Real generation latency with `@ai-sdk/anthropic` (default `claude-sonnet-5`). A direct `streamText` TTFB + total (honest first-token), and `apps.create()` end-to-end. ≥3 trials. See the honesty note below. |
| `e2b` | `E2B_API_KEY` | Real e2b wake latency: create → serve → snapshot, then `resume()` and resume→first-successful-request, ≥5 trials. Cleans up every sandbox. |

### Honesty notes

- **TTFB and `create()`**: the generation engine (`packages/apps/src/engine.ts`)
  calls the ai-SDK `generateText` (buffered, non-streaming), so a first-token
  time is not separable at the `create()` seam. `gen-live` therefore reports a
  direct `streamText` TTFB for a real first-token number *and* the buffered
  `create()` total separately.
- **`temperature` on `claude-sonnet-5`**: the engine hardcodes `temperature: 0`.
  `claude-sonnet-5` does not support `temperature`; the `@ai-sdk/anthropic`
  client drops the unsupported field with a warning (it is not sent), so
  `create()` succeeds. If a future SDK sends it and the API 400s, `gen-live`
  falls back to a temperature-compatible model (`VENDO_BENCH_CREATE_MODEL`,
  default `claude-haiku-4-5`) so a real engine-through-LLM number is still
  produced, and records the failure.
- **`ai` version**: bench pins `ai@^5` + `@ai-sdk/anthropic@^2` to match the
  frozen `@vendoai/apps` `LanguageModel` seam (spec v2). Passing a model built
  against `ai@6` (spec v3) to `createApps` fails typecheck against the frozen
  package.

## Budget philosophy

`budgets.json` sets a p95 ceiling (ms) per deterministic metric, keyed
`"<suite>:<case>"`. Only the render-only tree metrics, the PGlite store leg, and
the single-call/seam metrics are gated (not validate+render, not Postgres).

Ceilings were seeded from a dev-machine measured p95 (Apple M4 Pro; see
RESULTS.md for the run they were seeded from), and **per-metric headroom
deliberately varies** — there is no single multiplier:

- **Millisecond-scale metrics** (tree-render, guard-call) carry roughly **5–7x**
  headroom over measured p95. Enough to absorb a slower CI runner; tight enough
  that a real slowdown trips it.
- **Sub-millisecond metrics** (tree-validate, store, apps-api, gen-scripted) get
  **absolute floors of 1–8ms** instead. Relative headroom there works out to
  anywhere from ~9x to ~250x (e.g. `tree-validate:nodes-10` measures ~4µs
  against a 1ms floor), because relative multipliers are meaningless at
  microsecond scales — a single scheduler blip is 100x the signal. The floor is
  the smallest value that won't false-positive on a noisy runner.

RESULTS.md lists the actual measured p95, ceiling, and resulting multiplier for
every gated metric. The gate is meant to catch **real** regressions — an
accidental O(n²), a dropped index, a renderer that stopped memoizing — not
scheduler noise. A metric that suddenly takes an order of magnitude longer trips
the gate; one that wobbles between runs does not.

`--check` runs the deterministic suites, compares each gated p95 to its ceiling,
prints the table to stdout (and to `$GITHUB_STEP_SUMMARY` in CI), and exits 1
listing every breach. It **also fails when any ceiling key in `budgets.json`
matches no measured case** — otherwise renaming or deleting a suite/case would
silently turn its budget into dead config and the gate would stop gating.
(Partial runs — `--check --suite <name>` — skip the dead-config check by design;
it only applies to the full deterministic set, which is what CI runs.)

### Follow-up: recalibrate against real CI samples

The current ceilings are provisional, derived from one dev machine. Once
`perf.yml` has run on main a handful of times:

1. Collect the p95 values from the last ~5 job summaries (the tables are in
   each run's `$GITHUB_STEP_SUMMARY`).
2. For each gated metric, take the worst CI p95 observed and set the ceiling to
   ~3x that value (or keep the existing absolute floor if it is larger).
3. Land the recalibration as a single PR editing `budgets.json`, citing the CI
   runs sampled.

This replaces dev-machine guesswork with runner-derived headroom and should
tighten most ceilings considerably.

## Raising a budget

A budget increase is a deliberate, reviewed act — not something to bump away a
red build. To legitimately raise a ceiling:

1. Re-run the suite locally (`pnpm --filter @vendoai/bench bench -- --suite <name>`)
   and confirm the new p95 is a real, expected cost, not a bug.
2. Open a PR that edits `budgets.json` with the new value and a one-line
   justification in the PR body: what changed and why the higher cost is
   expected (e.g. "added server-side query resolution to open(); +3ms is the
   round trip").
3. If the number went up with no intended change, that is the regression the
   gate exists to catch — fix the code, don't raise the budget.
