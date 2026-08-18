---
"@vendoai/knowledge": patch
---

A hanging knowledge engine no longer taxes every turn. The prompt index asks the
adapter for `status()` when the sync state moves, and the wire client aborts that
call at its own 30s timeout — so an engine that was UP but not answering charged
30 seconds to every single turn before the prompt could be built, forever. A
status check that fails SLOWLY now leaves the engine alone for a minute; the turns
inside that window serve exactly what the failed check would have served, minus the
wait. A check that fails FAST — a refused connection, microseconds — is unchanged
and still retried on the very next turn, so a recovered engine is picked up at once.
