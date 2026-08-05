# Rematch gate — 2026-07-25 (three-arm A/B/C on the blind Tranche 4)

The post-#569 rematch: three candidate configs measured head-to-head on 30 blind fresh
prompts (Tranche 4, H1–H30, first commit of this branch), 90 creates total, real Apps
create path on production `next start` hosts, dedicated headless browser, one attempt
per prompt per arm, zero tuning.

| piece | file |
|---|---|
| Maple half (rows + summary + cross-arm findings) | `README-MAPLE.md` |
| Cadence half | `README-CADENCE.md` |
| Design pairwise (B-vs-A, C-vs-A on shipped pairs) | `design-pairwise.md` / `.json` |
| Raw rows | `results-maple.tsv`, `results-cadence.tsv` |
| Per-create pipeline events + refusal reasons | `pipeline-events-*.json`, `server-logs/` |
| Screenshots + aria snapshots + action-fire evidence | `shots/` |
| Harness | `driver.mjs`, `run-half.mjs`, `judge-pairwise.mjs`, `prompts.json`, `arm-schedule.json` |

## Scores

| arm | config | Maple | Cadence | total |
|---|---|---|---|---|
| A | production defaults (`pipeline: {}`) | 1/15 | 1/15 | **2/30** |
| B | `{ endPass: true }` (data-sighted verify) | 2/15 | 3/15 | **5/30** |
| C | `{ exemplarContract: true, endPass: true }` | 2/15 | 0/15 | **2/30** |

65/90 attempts produced NO app (create refused after repair, honest error in the UI, or
timed out past the 420s driver cap). The dominant mechanical cause — the island
smoke-render worker crashing on EVERY island under Turbopack-bundled production servers
(`require()` handed Turbopack's numeric module id 429302 instead of a path by
`createRequire(import.meta.url).resolve(...)`) — is environment-conditioned, arm-blind,
and root-caused in the PR body; it must be fixed before any arm's refusal column is read
as a statement about that arm's prompt stack.
