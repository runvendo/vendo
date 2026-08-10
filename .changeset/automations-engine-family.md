---
"@vendoai/automations": patch
"@vendoai/core": patch
"@vendoai/vendo": patch
---

automations reaches its own drawers through the `engine` op family

Every collection this engine owns — `vendo_apps`, `vendo_runs`, `vendo_grants`,
`vendo_approvals`, the captures, the arm rows, the schedule cursors, the webhook
secrets, the delivery ledger, and both sponsorship drawers — was reached through
the generic `store.records(...)` door a host uses for its own data. All 41 call
sites now go through `ops.engine.*`, so the allowlist gate in
`assertEngineCollection` applies to every one of them.

`AutomationsConfig` gains an optional `ops: StoreOps` beside `store`, threaded
from composition. It stays optional because `selectStoreOps` answers `undefined`
for a store with neither its own ops surface nor a SQL handle, and because a
host may construct the block directly with nothing but a `StoreAdapter`.

`engineOverAdapter` (new, in core) is that store's engine family: the allowlist
gate in front, the adapter's own record door behind. It lives in core because
automations, guard and apps all need it and none of them may import
`@vendoai/store`. Where `RecordStore.atomic` is absent it keeps exactly the
degradation those blocks used to hand-roll — `insertIfAbsent` becomes a
check-then-put, `compareAndSwap` a last write — so moving onto the family does
not turn a working BYO adapter into a `not-implemented`.

No behavior change: same collection, same verb, same arguments, same order.
