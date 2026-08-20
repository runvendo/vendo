---
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

A workspace upload the box never received no longer reads as the user deleting
everything.

The `claudeCode()` turn puts the workspace on the box before the model runs, and
that upload was the one unguarded network call in the turn. When it died before
the box applied it — a refused connect, a dead socket, a first chunk that never
landed — the turn's `finally` still read the box's disk back, the box answered
honestly that it held nothing, and the sync-back read "nothing here" as "the user
deleted everything" and erased the whole workspace from the store. The failed
READ was already guarded ("an EMPTY read is not the same fact as the user deleted
everything"); this was the same fact from the other end, and it had no guard.

Now the turn tracks whether the box actually holds the checkout, and syncs back
only if it does. A machine that never received the workspace makes no statement
about it: the store keeps what it had and the next turn recovers on a fresh box,
exactly as a machine that died mid-turn already did.

Two things that made it hard to survive and hard to diagnose are fixed with it.
The workspace calls — the upload and the turn-end read, both of which are the
same twice — are now sent again once if the transport drops, so a blip no longer
costs the turn. And a Cloud sandbox that cannot be reached now says so: the
adapter turns the transport fault into a named `sandbox-unavailable` failure
carrying the cause, and the runtime's operator log prints that cause alongside
the message. The observed failure used to reach the log as undici's bare
`fetch failed` — three words naming neither Vendo nor the call.
