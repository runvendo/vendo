---
name: genbench
description: Run Vendo's buy-vs-build generation benchmark — generation time + accuracy of the real Vendo pipeline vs raw-Claude baselines (diy, claude-code) on JSON-defined worlds. Use when asked to benchmark generation, compare Vendo vs raw models, measure generation speed/cost, or add genbench worlds/cases.
---

# genbench

One command, from the repo root (`ANTHROPIC_API_KEY` in the environment):

    pnpm build                                      # genbench reads the built @vendoai/* dists
    pnpm genbench run --prompt <case-id>            # one case, all contenders, opens preview.html
    pnpm genbench run                               # all screen cases
    pnpm genbench run --models opus,sonnet,haiku    # expand the harness x model matrix
    pnpm genbench run --world maple                 # choose world (default: maple)

Case ids in `maple`: `spend-overview`, `spend-chart`, `pending-transfers`,
`account-balances`, `no-pending-transfers`.

- Contenders: `vendo` (real pipeline, this working tree) · `diy` (one raw
  `streamText` call) · `claude-code` (stock Agent SDK in a scratch dir).
  Byte-identical world info per contender: ONE serializer, `worldBlock` in
  `genbench/src/vendo.ts`, enforced by the fairness test in
  `genbench/src/diy.test.ts` against what the vendo driver really receives.
- Worlds: `genbench/worlds/<name>/{world.json, cases.json}` plus an optional
  `font.woff2` the harness injects into every contender's page. `world.json` =
  tools + canned data + theme + style rubric; `cases.json` = prompt + `pass`
  lines. Conventions: money in cents; a tool with `data` is a read, `takes`-only
  is a write.
- Output: `genbench/runs/<run>/<contender>/<case>/{artifact.vendo (vendo only),
  page.html, screenshot.png, result.json}` + `preview.html` (live embedded
  screens, world-data panel, live tool-call feed). `runs/` is gitignored.
- Floor checks are deterministic (delivered / renders / valid / honestData /
  wiredActions via click-probe). The `pass` lines are the rubric a pinned judge
  (versioned rubric contract) grades on every run — any edit to its prompt
  bumps `rubricVersion` and resets comparability.
- Budgets are per contender: five minutes for `vendo` and `diy`, twelve for
  `claude-code`, which runs its own ten-minute wall clock inside the driver.
- Gotchas: test genbench with `pnpm --filter @vendoai/genbench test` (its
  `vitest.config.ts` caps the pool at 1-2 workers) — never the full repo suite,
  and not a bare `npx vitest`, which resolves a different vitest that rejects
  this repo's worker flags. `--lane build` is deferred and says so.
