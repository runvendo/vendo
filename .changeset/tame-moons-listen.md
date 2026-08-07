---
"@vendoai/harnesses": patch
---

`claudeCode({ machine: "local" })` now bounds a message the way the sandbox path
always has. A live session's turn ends on a `result`, and a `result` that never
arrives — an interrupted session, or a mid-build steer the model folded into the
turn already running — used to leave `send()` pending forever. Because
`ClaudeSession` answers pushed messages strictly in order, that took the whole
thread with it: the user's next message waited behind a turn that had already
silently lost, for the life of the process.

Both rungs now share one `MESSAGE_BUDGET_MS`. On the local rung a breach
interrupts the turn, drops the session, and throws — the disk stays warm, so the
next message opens a fresh session that resumes rather than a cold start.
