---
"@vendoai/apps": patch
---

A steered turn now ends when the engine says it is over, not when a guessed
number of `result` messages have arrived.

The live Claude session gave each steer one extra `result` to absorb, on the
belief that every user message the engine answers produces exactly one. Nothing
guarantees that — the engine's own docs describe a queued batch being "coalesced
into one turn", which is also what steering is documented to do (the words reach
the model at its next step boundary). One result short and the count swallowed
the FINAL result too, so `send()` waited out the whole 15-minute message budget
for work that had already finished. The count is now only a cap on the wait; the
engine's `session_state_changed` → `idle`, which its own schema calls the
"authoritative turn-over signal", is what ends the turn. The session asks for
that event explicitly (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), and an engine
that never sends it falls back to exactly the old behaviour.
