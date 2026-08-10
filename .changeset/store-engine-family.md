---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/vendo": minor
---

`engine` — the store family for Vendo's own drawers, behind an allowlist.

The `StoreOps` contract grows from 35 ops across 8 families to 42 across 9. The
new family is `engine`, and it is today's `records.*` family verb for verb —
`get`, `put`, `delete`, `list`, `claim`, `insertIfAbsent`, `compareAndSwap`, same
arguments, same returns, same routed doors — with one thing added in front of
every verb: `assertEngineCollection(collection)`.

**The point is the name and the gate, not new semantics.** Grants, approvals, the
audit log, threads, runs, apps, effects, the automations schedules and deliveries,
the guard's freeze switch — Vendo's own bookkeeping — all reached the store
through the same generic `records.*` door a host uses for its own data. Nothing
said which collections were Vendo's, so nothing could refuse a call that reached
for one. `engine` says it, and refuses everything else with `blocked`.

`ENGINE_COLLECTIONS` (`@vendoai/core`) is that list: 35 static names — the nine
reserved collections, the four dedicated tables, and the 22 the blocks own on the
generic table — plus exactly one dynamic pattern, `vendo:app-history:<id>`, built
by `engineAppHistory(appId)`. It lives in core rather than `@vendoai/store`
because `guard`, `automations` and `apps` all need to name their own collections
and none of them may import the store; `@vendoai/store` is what *enforces* it. A
refused name is told the allowlist version, the nearest allowed name when it
looks like a typo, and where its data actually belongs — app data belongs to
`appData`.

**Per-collection policy did not move.** `engine` reaches the same
`createReservedRecordStore` doors, so the audit log is still append-only through
it, the effect ledger is still insert-once, and a collection with no atomic
support still answers `not-implemented`. Two conformance cases pin exactly that,
because a second door onto the same rows is the natural place for policy to
quietly stop applying.

Seven wire paths under `/engine/*` join `vendo/store-wire@1`, served by the local
Postgres backend, the Cloud client and the in-core memory reference, with seven
conformance cases run by all three. The seven collection-addressed request
schemas are renamed `storeWireCollection*RequestSchema` — one body shape now
serves both `/records/*` and `/engine/*` — and the old `storeWireRecords*` names
stay exported as deprecated aliases.

`records.*`, `StoreAdapter` and every existing call site are untouched.
