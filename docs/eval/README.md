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
| **Knowledge eval (retrieval/answers/refusals)** | [`KNOWLEDGE.md`](./KNOWLEDGE.md) | Golden + refusal sets, per-engine bars, per-PR offline gate; judge legs nightly (`pnpm corpus knowledge-eval`) |
| **Measurement verdicts** | git history (formerly `docs/verification/w1-bench/`, scrubbed in #782) | Decided: inline refs ADOPT; builder-calls, fetch-then-generate, CFG-JSX DEFER |
| **Gate + baseline evidence** | branches `vendo-heldout-maple`/`-cadence`, `vendo-gate-*`; scrubbed `docs/verification/` dirs live in git history | The 11/30 baseline, the 2026-07-20 gate run (18/30, 8/10), and the pre-freeze dev-set record (contaminated; never a quality number) |

## Conventions going forward

- **Future gate runs land in `docs/eval/runs/<YYYY-MM-DD>/`** (README + screenshots per
  half; the directory is gitignored — runs stay local or on evidence branches), not new
  ad-hoc `docs/verification/` dirs.
- **Fresh sets are authored blind before each gate, run once, then frozen** as a new
  tranche in GOLDEN.md with their baseline. Never reuse a fresh set as fresh.
- **Prompts discussed in fix PRs are burned** to the DEV list (GOLDEN.md rule 4).
- Boot recipes for the demo hosts (production-only; never `next dev`) live in the gate
  TASK files on the evidence branches.

## Relationship to genui-bench

`tools/genui-bench` is the **lab**: the interactive side-by-side playground — competitor
comparisons (CopilotKit/thesys/Tambo), model A/Bs, pipeline experiments — running on the
real in-repo renderer and engine. (It superseded the external `runvendo/genui-bench`
research repo, now archived.) This directory is the **scoreboard**: frozen sets and
official scores. Ideas graduate from the lab; only this scoreboard decides if they
shipped well.
