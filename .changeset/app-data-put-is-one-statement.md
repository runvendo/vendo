---
"@vendoai/store": patch
---

`appData.put` decides the owner conflict in ONE statement, so an absent-row race
can no longer destroy a foreign owner's data.

`put` read then wrote: `insertIfAbsent`, then `SELECT … FOR UPDATE`, then an
unconditional upsert. `FOR UPDATE` locks **nothing** when it returns no row, so
a holder who deleted the id after the insert lost and before the select ran left
the composer looking at an absent row — and the upsert then overwrote and
re-stamped whichever owner had taken the id in the meantime, silently destroying
a row that owner could still neither read nor delete. The existing `conflict`
refusal closed the common case and not this one.

The put is now a single owner-predicated upsert: `ON CONFLICT … DO UPDATE …
WHERE refs @> <owner stamp>`, which takes the conflicting row's lock before it
evaluates its predicate, so a foreign holder makes the statement touch no rows
and the caller gets `conflict`. Absent, or already ours, still succeeds. No
application-level locking, no widened transaction, no schema change.

Proven on real Postgres with a second connection churning the id at the
composer's statement boundaries (`packages/store/tests/app-data-put-race.test.ts`);
PGlite is single-connection and cannot express the interleave.
