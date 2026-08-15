---
"@vendoai/core": minor
"@vendoai/store": minor
---

Six capabilities the StoreOps contract was missing, so nothing has to reach
around it into raw SQL to get them.

- `audit.list` — the audit drawer's own typed read, filtered by kind, venue,
  outcome and decidedBy, on the same keyset cursor `engine.list("vendo_audit")`
  already walks. `venue` is a column, `outcome` and `decidedBy` live inside the
  event, and no `engine.list` ref key reaches any of them.
- `secrets.{get,set,list,delete}` — the store's vault, on the wire. Values cross
  in the clear under TLS and are encrypted at rest server-side, so no key ever
  leaves the mount; the local engine keeps the `vendo_secrets` table and the
  envelope cipher it already had.
- `footprint()` — per-collection byte accounting, with each collection's kind
  (`storage` or `knowledge`) alongside. `bytes` is row-content size, uniform
  across collections and comparable with itself over time — deliberately not a
  relation size, because most collections share one table and a per-collection
  disk number does not exist to report.
- `engine.list`'s `watermark` bound — the forward walk `cursor` cannot express:
  everything after a mark, oldest first, so a job that has already counted rows
  resumes where it stopped instead of re-reading from the newest. Valid only on
  fields the collection registry declares indexed (`vendo_runs.started_at`
  today), and the bound is opaque and full-precision on purpose: a mark
  round-tripped through a JS `Date` truncates to milliseconds, moves BACKWARDS,
  and re-counts a window. The answer echoes the next bound back, which is also
  how a caller detects a mount too old to have honored it — a request field, unlike
  a new op, has no 501 to protect it.
- `retention.{quarantine,purge}` — aging rows out of a collection in two moves,
  because the gap between them is the recovery window. OPTIONAL, and no
  implementation ships one yet: the contract is frozen here and the engine that
  owns the quarantine lands next.
- `IdempotencyLedger` — server-side only, no wire op. `createStore()` provides
  one, and implementations MUST colocate it with the mutations it gates: a
  ledger that can commit while its mutation rolls back will confidently replay
  an answer for work that never happened.

`ENGINE_COLLECTIONS` is now derived from `ENGINE_COLLECTION_REGISTRY`, which
carries each collection's kind and indexed fields. Same 38 names, same order; a
second place naming them is how an allowlist rots.
