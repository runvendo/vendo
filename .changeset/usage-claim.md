---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/vendo": minor
---

`usage.claim` — a quota is admitted and spent in one step.

`Limiter.gate` was check-then-record. It handed the host's policy a `count`
closure, awaited the verdict, and only then wrote the usage event — with nothing
holding the subject in between. Two overlapping requests could both count under
the cap, both be allowed, and both record, landing one more action than the cap
permits for however many were genuinely in flight.

The reservation the idempotency ledger takes has no equivalent here, and that is
what made this awkward rather than obvious: a quota has no unique key to insert
against, and **the cap belongs to the host, not to Vendo**. `gate` never learns
the number the policy compared to, cannot know whether the policy will call
`count` at all, and cannot know how many times. So the reservation is a
compare-and-swap on the numbers the policy actually read:

```ts
// gate remembers every count the policy read, then admits only while they hold
const admitted = await store.ops.usage?.claim?.(event, [{ query, count: 3 }]);
// true  — the meter has not moved; the event is RECORDED in the same step
// false — a count moved; nothing was written, so ask the policy again
```

- **No host API change.** `LimitsCallback` is untouched. A policy still reads
  `count` and compares it to a cap this side never sees.
- **An empty stake is an unconditional write.** A policy that never read the
  meter has no race to lose, so it is admitted on the first pass.
- **A lost reservation re-asks the policy, it does not deny outright.** Losing
  means the verdict was reached against numbers that no longer exist, not that
  the user hit their cap — so the policy decides again on fresh ones. After
  three passes `gate` DENIES, on the same rule a throwing policy denies under: a
  cap that is real is not worth admitting over because the meter is busy. This
  is why `LimitsCallback` is documented as asked "before each" action rather
  than exactly once, and why a policy should stay a decision with no side
  effects of its own.
- **The lock covers what the write touches, not just what was read.** The
  Postgres implementation takes a transaction-scoped advisory lock over every
  observed subject/pool AND the event's own `subject`/`poolKeys`, sorted so no
  two callers can deadlock. Locking only the observed targets leaves the hole
  intact: a contender who never counts a pool still draws it down, and would
  slip past an observer of that pool.
- **A conditional INSERT would not have worked.** `INSERT ... WHERE (SELECT
  count(*) ...) = n` reads its own snapshot under READ COMMITTED, so both racers
  count the old number and both insert — the same defect wearing the right
  shape. The lock is what orders them, and the window it covers is a count and
  an insert; the host's policy has already returned by then.
- **OPTIONAL, on `RecordStore.claim`/`atomic`'s rule.** An adapter that cannot
  reserve omits it and the limiter falls back to count-then-record. The hosted
  client omits it deliberately: atomicity would have to live in the mount,
  behind a wire path that does not exist yet, and a client that posted to one
  anyway would be claiming a guarantee nothing on the other end makes. **Vendo
  Cloud therefore keeps the bounded overrun until the mount serves the verb.**

Served by the Postgres meter and the in-memory reference, with conformance cases
run on both — including two claims fired at one instant under a cap of one. The
kit's mutation suite carries three new proofs, one of them the read-then-write
implementation that passes every sequential case and still admits both racers.

Closes #1328.
