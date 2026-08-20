---
"@vendoai/ui": patch
---

A failed app surface says why, instead of printing its own discriminant. The
terminal `{kind:"failed", reason}` that `open` started answering had no consumer
on either renderer: `AppFrame` fell through to its unknown-kind catch-all and put
`Unsupported app surface "failed".` on a host's logged-in dashboard, and a slot
never reached the card that already knows how to say this — a placement's status
is build-time truth, so a build that landed and a screen that has since stopped
compiling both read as "ready", and only the open knows the difference.

Both consumers read the kind now. `AppFrame` contains the reason in the same
notice every other in-surface failure uses, and a mounted slot hands the failed
surface to the existing build-failed card: the reason, and the way back to the
host's own markup. Placement status is untouched — it reports the build honestly,
and the consumer side is where this belonged.
