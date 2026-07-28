---
"@vendoai/vendo": minor
---

Wire the judgment channel into `init`, `sync` and `try`, and delete the three AI
systems it replaces.

`init` and `sync` now run `runJudgmentPass` instead of the staged AI extraction
and the sync enrichment pass. The difference that matters is WHERE model output
lands and what it costs to get there: a proposal needs a verbatim source quote,
an independent skeptic checks it against the real handler, hardenings and prose
apply themselves into `.vendo/judgments.json`, and loosenings — lower risk, wider
audience, a woken tool, a cleared critical mark — wait for a human. So
`overrides.json` goes back to meaning only "what a person decided", and a
re-sync can no longer clobber either file.

Deleted outright: the staged extraction pipeline (survey → draft-per-surface →
cross-check) with its prompts, `runAiExtraction`/`applyDraft` and the whole
`cli/enrich/` pass (watermark diff, restrictive-only clamp, tripwire), and the
`vendo extract --apply` delegation path — including the `aiPolish` contract the
`init --agent` plan used to carry, which no external agent can honour now that a
judgment requires quoted evidence. `vendo extract` exits as an unknown command.

The prose half survives as two focused stages, `runBriefStage` and
`runThemeStage`; the brief prompt now reads the JUDGED catalog rather than a
draft. `vendo try`'s background deepening runs judgment → brief → seeds and
queues loosenings instead of prompting, since that surface is non-interactive by
design.

Flags: `vendo sync --no-watermark` is renamed `--no-ai` (the old name keeps
working as a silent alias); `--review` now shows the queued and new loosenings;
`--full` judges the whole catalog instead of only what moved.

Also fixed: `vendo doctor`'s live-surface check and the `try` profile's tool
summaries hand-rolled a tools+overrides merge that would have disagreed with the
runtime once judgments existed. Both now resolve the same three layers the
runtime does — skeleton ⊕ judgments ⊕ overrides — so a disable either surface
reports is one the agent actually sees.
