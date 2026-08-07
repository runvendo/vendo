---
"@vendoai/vendo": patch
---

Internal refactor: the CLI's longest functions are split into the steps their
own section comments already named. `runDoctor` becomes an itinerary over
per-section check modules, `runJudgmentPass` a pipeline of named stages,
`runInit`/`buildPlan` their labelled steps, `runSyncFlow` its five stages, and
`main` a flat command table. Behaviour, output text and exit codes are
unchanged, and no public surface changed: every exported name, signature and
module path is identical.
