---
"@vendoai/store": minor
---

The turn envelopes, served. The local backend answers `turn.load` by fanning out over the very ops it bundles (`transcripts.getThread`, `workspace.index`, `workspace.read`, and `harness.get`/`usage.count` when asked for), and `turn.commit` lands the batch append, the harness state and the run's audit row inside ONE `db.transaction()` — a turn that landed its messages and lost its harness state is a turn the next one resumes wrong. `/status` now reports `ops: 50`, which it may do because the two ops are genuinely served. The hosted client gains both, and they are the one family it feature-detects before sending: ONE cached `/status` read compared against `STORE_WIRE_TURN_OPS`, exactly as the batch append is detected, because this is the one shape with a cheaper fallback to route to — a mount below the level is served by the individual calls the caller always made, never by reading a failed mutation as a capability answer.
