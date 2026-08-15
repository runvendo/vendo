---
"@vendoai/core": minor
"@vendoai/store": minor
---

`StoreOps.retention` gets an engine. The contract declared the family last
release and nothing served it; the local backend serves both verbs now, so
`status().ops` reaches 44 and the two conformance cases that shipped tagged
`pending` are ordinary cases every mount is held to.

- `retention.quarantine(collection, olderThan)` lifts every row whose own age
  field predates the cutoff OUT of the live collection, and answers how many
  moved. Re-running it moves nothing.
- `retention.purge(collection, quarantinedBefore)` destroys what was lifted
  before ITS cutoff — measured from the lift, not from the row's age, because
  the grace it honors starts when the row left.

The gap between the two is the whole feature: a retention window that turns out
to be wrong is recoverable right up until the purge, which is what a
`DELETE ... WHERE at < ...` on the public table map could never offer. Host SQL
on a host's own cron still works and always did.

Schema v9 adds `vendo_quarantine`, the engine's own drawer for lifted rows — no
caller names it and `purge` is the only way back out. It holds each row
verbatim (`to_jsonb` of the live row, whichever table it came from), so a
restore has everything the sweep took. The lift is one data-modifying CTE, so a
row is never in both places and never in neither.

A quarantined row is still its owner's data, so the sweep copies the subject and
app id onto it and both legs of the erase cascade match them: quarantining can
never become a way to outlive an erasure. `vendo_threads` and `vendo_apps` are
refused (`blocked`) rather than half-swept — a thread's transcript and harness
state and an app's whole drawer live in other tables, and lifting the row alone
would strand them. For the same reason a sweep sees exactly what a collection's
own door sees: `vendo_state` holds an app's state AND a live thread's harness
continuity, and only the first is a collection anyone can name, so only the
first is swept.

`memoryStoreOps()` serves the family too, so the conformance kit runs the cases
against its own reference.
