---
"@vendoai/guard": minor
---

`guard.reportThrough(event, place)` — `report` with the audit row handed to a placer instead of written to the guard's own engine, so a batched turn can fold its ONE run row into the same call as the messages it describes. It IS `report` (which is now this, with the engine as the placer), so normalisation and the decision metric are unchanged. Per-tool-call decisions keep writing one row per call.
