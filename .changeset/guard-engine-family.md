---
"@vendoai/guard": patch
"@vendoai/vendo": patch
---

guard's own drawers ride the `engine` family

Approvals, grants, the audit log, the effect ledger, the freeze switch and the
one-time transition receipts all reached the store through the generic
`records.*` door a host uses for its own rows. They now go through
`ops.engine.*` — the same seven verbs, the same collections, the same order,
with the allowlist gate in front of every one of them.

`createGuard` takes an optional `ops: StoreOps` beside `store`, threaded from
the composition. Unset (a `StoreAdapter` with neither its own ops nor a SQL
handle — every BYO adapter), the same seven verbs are served off the adapter's
own record doors, gate included.
