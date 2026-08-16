---
"@vendoai/vendo": minor
"@vendoai/harnesses": minor
---

The harness turn now opens with ONE `turn.load` and closes with ONE `turn.commit` on a store that serves them. A quiet turn against a hosted mount costs three calls — the envelope, the user's message (landed before the model runs, so a turn that dies never loses it), the envelope — where it used to cost six. Feature-detected against `/status` once per deployment and never blind-sent: below `STORE_WIRE_TURN_OPS`, and on any store with a SQL handle (already one hop from its rows), every door reads and writes exactly as it always did, retry and per-write isolation included. Per-tool-call writes are untouched by design: the guard's audit row, the effect ledger, the workspace commit after every tool call, and the parked-approval checkpoint all stay per occurrence.
