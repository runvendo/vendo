# Vendo generation eval — the front door

This directory is the canonical home of the generation-quality eval. If you are about to
measure, improve, or make claims about generation quality, start here.

## The one-paragraph story

Unit tests and dev-set demos repeatedly said "done" while real generations were broken
(dev-set 6/6 vs held-out 11/30, 2026-07-19). The fix is this eval: frozen prompt sets that
no fix is ever tuned against, run ONCE per wave through the real engine on real hosts in a
real browser, judged against a written PASS bar with committed screenshots. Numbers from
anywhere else are not quality numbers.

## The pieces

| Piece | Where | What it is |
|---|---|---|
| **Golden set + rules + PASS bar + run ledger** | [`GOLDEN.md`](./GOLDEN.md) | The frozen prompts (30 + F-set), the never-tune rules, every official score |
| **Remix eval (fork/pin/ship-diff/drift)** | [`REMIX.md`](./REMIX.md) | The frozen 12 remix scenarios + PASS bar + ledger (baseline 2/12, 2026-07-21) |
| **Bench harness** | `packages/apps/src/bench/` | Rerunnable format/pipeline experiments against the REAL compiler (metrics, LLM-judge rubric, dev prompts, fixtures). `ANTHROPIC_API_KEY` + `pnpm --filter @vendoai/apps exec vitest run src/bench/<exp>.bench.test.ts` |
| **Measurement verdicts** | `docs/verification/w1-bench/VERDICTS.md` | Decided: inline refs ADOPT; builder-calls, fetch-then-generate, CFG-JSX DEFER (with numbers + revisit conditions) |
| **CFG grammar + GPU protocol** | `docs/verification/w1-bench/wire-subset.lark` | Ready-to-run owned-serving experiment (~1 GPU-day) |
| **Latest gate evidence** | `docs/verification/final-gate/` | 2026-07-20 run: per-prompt rows + 64 screenshots (18/30, 8/10) |
| **Baseline evidence** | branches `vendo-heldout-maple`/`-cadence`, `vendo-gate-*` | The 11/30 run + raw gate branches |
| **Historical dev-set evidence** | `docs/verification/vendo-v2-*` | The pre-freeze iteration record (contaminated; never a quality number) |

## Conventions going forward

- **Future gate runs land in `docs/eval/runs/<YYYY-MM-DD>/`** (README + screenshots per
  half), not new ad-hoc `docs/verification/` dirs.
- **Fresh sets are authored blind before each gate, run once, then frozen** as a new
  tranche in GOLDEN.md with their baseline. Never reuse a fresh set as fresh.
- **Prompts discussed in fix PRs are burned** to the DEV list (GOLDEN.md rule 4).
- Boot recipes for the demo hosts (production-only; never `next dev`) live in the gate
  TASK files on the evidence branches.

## Relationship to genui-bench

`runvendo/genui-bench` is the **lab**: product-independent research — wire-format wars,
pipeline prototypes, competitor comparisons (CopilotKit/thesys/Tambo). This directory is
the **scoreboard**: it measures the real product and cannot leave this repo without
drifting into measuring a copy. Format-level ideas graduate from the lab; only this
scoreboard decides if they shipped well.
