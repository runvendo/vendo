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
carrying the cause, and the runtime's operator log prints the ROOT of that cause
chain alongside the message. The observed failure used to reach the log as
undici's bare `fetch failed` — three words naming neither Vendo nor the call.

The retry is what made the rest necessary. Aborting a request cancels this host's
leg of it and nothing else, so a chunk this host gave up on can still land after
its own replay — and the first chunk of an upload carries the reset that empties
the box's root. Every materialize now mints a GENERATION and carries it on each
chunk: the box refuses a generation it has already moved past, empties the root
once per generation instead of once per request, and reports the generation it
holds. That report is also how a box whose supervisor RESTARTED — same machine,
same token, empty disk — stops passing as the box that holds the conversation:
the host reads its own generation back before it treats an empty disk as news.

**The box image must be rebaked for the generation to take effect** — half of it
lives in the machine image, beside the supervisor. A host on this version against
an older image is safe but unprotected: the box ignores the generation it is sent
and reports none, and an absent report is tolerated on purpose, so the seam
behaves exactly as it did before rather than refusing every sync-back until the
rebake lands. Such a turn now logs `harnesses.claude-code-box-no-generation`, so
the unprotected window is visible while it is open.

And the retry itself now knows what a retry is for. It replayed everything,
including answers — a meter refusal, a rejected key, a machine the provider had
destroyed — and threw the first error away to say the second one twice. Only a
call that DROPPED may be sent again, only while the box is still waiting for it,
and the attempt that failed is logged rather than discarded.
