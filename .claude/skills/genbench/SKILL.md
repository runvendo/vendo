---
name: genbench
description: Run Vendo's buy-vs-build generation benchmark — generation time + accuracy of the real Vendo pipeline vs raw-Claude baselines (diy, claude-code) on JSON-defined worlds. Use when asked to benchmark generation, compare Vendo vs raw models, measure generation speed/cost, or add genbench worlds/cases.
---

# genbench

One command, from the repo root (`ANTHROPIC_API_KEY` in the environment):

    pnpm build                                      # genbench reads the built @vendoai/* dists
    pnpm genbench run --prompt <case-id>            # one case, all contenders, opens preview.html
    pnpm genbench run                               # every case in one world
    pnpm genbench run --models opus,sonnet,haiku    # expand the harness x model matrix
    pnpm genbench run --world maple                 # choose world (default: maple)
    pnpm genbench run --world all                   # every world into ONE run folder

The corpus is **14 worlds, 200 cases** — 15 per world, except `buildlog` and
`fieldops` at 10. Case ids in `maple`: `spend-overview`, `spend-chart`,
`pending-transfers`, `account-balances`, `no-pending-transfers`,
`transfer-receipt`, `cancel-both-pending`, `transfer-activity-feed`,
`room-for-dana`, `rent-check`, `bills-calendar`, `money-dashboard`,
`dining-budget-cap`, `category-groups`, `savings-goals`.

- Contenders: `vendo` (real pipeline, this working tree) · `diy` (one raw
  `streamText` call) · `claude-code` (stock Agent SDK in a scratch dir).
  Byte-identical world info per contender: ONE serializer, `worldBlock` in
  `genbench/src/vendo.ts`, enforced by the fairness test in
  `genbench/tests/diy.test.ts` against what the vendo driver really receives.
- Worlds: `genbench/worlds/<name>/{world.json, cases.json}` plus an optional
  `font.woff2` the harness injects into every contender's page. `world.json` =
  tools + canned data + theme + style rubric; `cases.json` = prompt + `pass`
  lines. Conventions: money in cents; a tool with `data` is a read, `takes`-only
  is a write.
- Output: `genbench/runs/<run>/<contender>/<case>/{artifact.tsx (vendo only),
  page.html, screenshot.png, result.json}` + `summary.json` (the run's ONE
  aggregate, per column) + `preview.html` (live embedded screens, world-data
  panel, live tool-call feed). `runs/` is gitignored. `<contender>` is the column
  slug `<harness>-<model>` — `vendo-sonnet`, `diy-opus`, `claude-code-haiku`.
  Under `--world all` the case folder is `<world>/<case>`, because two worlds
  ship the same case id.
- Floor checks are deterministic (delivered / renders / valid / honestData /
  wiredActions via click-probe). A check with nothing in front of it is VACUOUS
  and one whose grader was unreachable is DEGRADED; neither scores, in either
  direction. The `pass` lines are the rubric a pinned judge (versioned rubric
  contract) grades on every run — any edit to its prompt bumps `rubricVersion`
  and resets comparability.
- Exit code: **any floor failure exits 1**; a judge outage or a failed rubric
  line does not. The last stdout line says which — `floor failures: 2 (exit 1)`.
  Through `pnpm` that is followed by pnpm's own `ELIFECYCLE` line, which is not
  a second failure.
- Judge spend is reported separately — `judged.cost` in `result.json` and one
  line under the preview's run header. It is NEVER folded into a contender's
  `cost`, which is only what that contender spent building its screen.
- Budgets are per contender: five minutes for `vendo` and `diy`, twelve for
  `claude-code`, which runs its own ten-minute wall clock inside the driver.
- Rough cost: one case ≈ 1-4 min ≈ $0.30-$0.50 + judge; one world is 10-15x
  that and `--world all` is 200x; `--models` multiplies by the model count. Prices in
  `src/meter.ts` are as of 2026-08-08 (Sonnet 5 is on intro pricing through
  2026-08-31) — token counts are the durable number, dollars are not.
- `--prompt` runs open `preview.html` on macOS; full runs just print the path.
  `CI` or `GENBENCH_NO_OPEN=1` suppresses the window.
- Gotchas: test genbench with `pnpm --filter @vendoai/genbench test` (its
  `vitest.config.ts` caps the pool at 1-2 workers) — never the full repo suite,
  and not a bare `npx vitest`, which resolves a different vitest that rejects
  this repo's worker flags. The two money-spending tests (judge smoke,
  claude-code driver) need `GENBENCH_LIVE=1` **and** `ANTHROPIC_API_KEY`; both
  stay skipped otherwise. `--lane build` is deferred and says so.
