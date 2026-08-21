---
"@vendoai/core": minor
"@vendoai/store": minor
---

`IdempotencyLedger.claim` — the refusal moves in front of the mutation.

The ledger was check-then-do, so two concurrent requests carrying one key both
found it fresh and both executed. For an EQUAL body that is benign and always
was: one key, one body, one effect, and whichever request answers first is the
answer every later replay gets. For a DIFFERENT body it was not. Both mutations
committed, and the loser was then refused `conflict` by a verb that ran AFTER
its write — an error naming the key while the write it refuses sits in the
store, which is the one thing an idempotency ledger exists to prevent.

`claim` reserves `(tenant, op, key)` for a request hash BEFORE the mutation
runs, in one statement against the scope's own primary key, so the key itself is
the serialization point:

```ts
const held = await store.idempotency?.claim?.(scope, requestHash);
if (held === "claimed") {
  // the reservation is ours: do the work, then record the answer
} else if (held !== null && held !== undefined) {
  // a prior owner already published: replay it, apply nothing
}
// null: same body, not yet answered — proceed, exactly as check's null says to
```

- **`null` means PROCEED, not wait.** A contender carrying the same hash is the
  benign case the ledger has always permitted to execute twice, so it is told to
  go — never to block. A contender that waited would hang behind an owner that
  died between `claim` and `record`, which is the ordinary client-timeout retry
  (`hostedStoreOps` replays the same key on exactly that path).
- **No lease, and none would help.** An expiry cannot tell a dead owner from a
  slow one, so it buys back the double-execution it was added to prevent while
  adding a way to steal a live owner's key. A dropped request costs one
  execution, which is what it cost before; it never costs the key.
- **A reservation is not an answer.** `check` and `claim` share one reader, so
  the two cannot drift on what a held row means — a divergence there reopens the
  race, since a `check` caller told "fresh" mutates straight past a reservation.
- **`record` settles the reservation it owns, and only that one.** First ANSWER
  still wins: an answered key is never overwritten, and a request that never held
  the key cannot stamp its own answer onto one, which is reachable on the `check`
  fallback where a key can be taken between the check and the record.
- **No migration.** `status = 0` is the reservation. It rides the existing column
  because 0 is not a status a mount can send, so no reader — including a console
  copy of the table that predates this verb — can mistake a reservation for a
  replayable result, and no row of that shape exists until something calls
  `claim`.
- **OPTIONAL, on `RecordStore.atomic`'s rule.** An adapter that cannot reserve
  omits `claim`; a caller that finds it absent falls back to `check` then
  `record` with the race that implies. Nothing in the repo is required to adopt
  it, and `workspace.commit` does not — it already claims its own ledger row
  inside the mutation's transaction, which is the stronger guarantee `claim`
  approximates for callers that cannot enclose their mutation.

Served by the Postgres ledger and the in-memory reference, with conformance
cases both run — including concurrent claims fired at one instant, because a
read-then-insert implementation passes every sequential case and still lets both
racers reserve.
