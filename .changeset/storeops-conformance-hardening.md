---
"@vendoai/core": minor
"@vendoai/store": minor
---

The StoreOps conformance kit stops being a sequential kit, and six places where
the three implementations disagreed are closed. A second implementation of the
contract can no longer pass the suite while being wrong about concurrency,
tenancy, or the batch append.

**Races.** Every atomic op in the contract was proven by two calls in sequence,
and a sequence cannot see the window a concurrent caller lands in: a
read-then-write with no atomicity underneath passes every sequential case ever
written and loses one of two simultaneous writers in production. `engine.claim`,
`engine.insertIfAbsent`, `engine.compareAndSwap`, `workspace.commit`'s
compare-and-swap and a double-fired idempotency key are now fired at one instant
with `Promise.all`. Nothing asserts which caller won — either winning is
correct — only that exactly one did and that the row the store kept is the row
that winner was handed. The double-fire asserts what the contract actually
promises and no more: `IdempotencyLedger` guarantees REPLAY protection, not
mutual exclusion, so two concurrent requests carrying one key may both execute;
what may not happen is a third request, after the key has an answer, applying
anything.

**Tenancy.** `StoreOpsConformanceOptions.makeNeighbour` is a second handle on
the same physical store bound to a different tenant. Supply it and one case
proves records, blobs, app rows, threads, secrets and workspace files stay
apart in both directions, and that one tenant's `lifecycle.erase` cannot reach
the other's. A single-tenant store leaves it off and the case reports as
OMITTED, never as a pass.

**Omissions are counted.** `ConformanceCase.run` may now resolve to
`{ omitted: reason }`, and `ConformanceReport` gains an `omitted` bucket, so
`passed + pending + omitted + failures === cases`. The cases over the two
optional members (`transcripts.appendMessages`, `retention`) used to `return`
early on a mount that omitted them, which the report counted as a PASS — "this
mount has no batch append" and "this mount's batch append is correct" were the
same green line, and a whole family could be dropped invisibly.

Two consequences of that landing alongside the retention engine: the memory
reference now serves every op the manifest declares, so its `status()` reports
`Object.keys(STORE_WIRE_PATHS).length` rather than a literal that goes stale the
day an op is added; and its `lifecycle.erase` sweeps quarantined rows on BOTH
legs, matching the subject and app id the local backend copies onto every lifted
row. Without that second one a retention lift is a way for data to outlive an
erasure — the reference would have disagreed with the only shipped engine on the
one cascade nobody gets to re-run.

**`transcripts.appendMessages`** gains cases for batch ordering after the tail,
edit-by-id in place without moving the message, the refusals (an empty batch,
two messages under one id), the thread it creates when the id is new, and a
revision that moves on every batch including an edit. The memory reference now
serves the op (and reports op level 36) so the kit has a complete reference to
run them against.

**Untested branches now covered:** `engine.claim`'s no-replacement delete form,
`engine.list`'s ref filter (exact containment, ANDed), `appData.list`
pagination with the owner scope re-applied on every page, `appData`'s
per-appId isolation, blob namespace isolation on every verb,
`lifecycle.erase({ appId })`, the `$vendoWorkspaceBytes` envelope round-tripping
untouched, and the commit conflict's `detail.conflicts`.

**Divergences closed**, each because two of three implementations already
agreed and the third was the outlier:

- `transcripts.getThread`'s `cursor`/`limit` are **removed** from the contract,
  the wire schema and the cloud client. They arrived by pattern-cloning the list
  ops, were implemented by nobody, and were marshalled blind by the client — a
  caller that passed `{ limit: 50 }` got the whole transcript back and no way to
  notice. They cannot be implemented as declared either: the answer is one
  `VendoRecord`, which has nowhere to carry a next-page cursor, so a windowed
  read could never say there is more. Paging a transcript needs an op whose
  answer has room for one. `.passthrough()` means a client still sending them is
  read, not refused.
- **Zero-byte blobs** are content, not absence. The wire's `bytes` field
  required a non-empty base64 string, so an empty file was refused by the client
  while both local implementations stored it happily — and the caller's `get`
  then answered null exactly as it would for a key nobody wrote.
- **`workspace.read([])` answers `{}`** and **`workspace.commit([])` is refused
  as `validation`**, everywhere. Reading nothing has exactly one answer; an
  empty commit has none (a commit id and a trail entry for a change nobody
  made, or silence), and the wire had always refused it while the local half
  accepted it.
- **`transcripts.appendMessages([])` is refused as `validation`**, matching the
  wire. The SQL half accepted it and bumped the thread's revision — and would
  CREATE a thread — on a call that landed no messages.
- **`VendoError.detail` crosses the wire.** The error envelope carried a code
  and a message, so every structured payload a refusal carried was readable
  locally and lost to a hosted caller: `workspace.commit`'s conflict names the
  paths that moved, and the hosted path had to re-read the whole index and
  re-derive them by hand. `detail` is optional and passed through untouched.
- **`workspace.commit`'s idempotency ledger is scoped to the owner.** The row id
  was built from the key alone, so two owners picking the same key — which
  clients do routinely — had one owner's commit answered out of the other's
  ledger row, as a replay when the bodies matched and as a `conflict` when they
  did not. This is the rule `IdempotencyScope`'s `tenant` field already states.

The hosted workspace's owner-defaulting divergence is **pinned, not fixed**: the
local implementations resolve an omitted `owner` to a bound constant and the
cloud client defers it to the mount, whose default lives in the console where
OSS cannot see it. A new case pins what every mount owes regardless — that the
default drawer is ONE drawer on all four verbs.
