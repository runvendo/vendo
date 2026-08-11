---
"@vendoai/mcp": patch
"@vendoai/vendo": patch
---

the door's OAuth drawers ride the `engine` family

Registered clients, consent interactions, authorization codes, access and
refresh grants and their family anchors all reached the store through the
generic `records.*` door a host uses for its own rows. All 18 sites now go
through `ops.engine.*` — the same two collections, the same verbs, the same
arguments, the same order, with `assertEngineCollection` in front of every one
of them. `store.records(...)` is gone from `packages/mcp/src` entirely.

`createMcpDoor` takes an optional `ops: StoreOps` beside `store`, threaded from
the composition. Unset — a `StoreAdapter` with neither its own ops nor a SQL
handle, which is every BYO adapter — `engineOverAdapter` serves the same seven
verbs off the adapter's own record doors, gate included, so an unset slot is a
route and not a downgrade.

Two consequences of the capability check moving off the call sites. `claim` is
optional on a record handle and absent on a store that cannot compare-and-claim,
so each site used to pre-check the handle; on the engine family the verb is
always there and refuses with `not-implemented` instead. Every OAuth refusal a
client could already see is unchanged, including all four `server_error`
bodies — but on such a store a refresh rotation now discovers it after writing
its candidate grants rather than before, leaving two rows nothing can ever reach
(their secrets were never returned) on a store where no rotation could have
succeeded either way; and a revoke that matches no token answers RFC 7009
success instead of that `server_error`.

`vendo_threads` stays on the record façade deliberately, as the umbrella's
threads do: its routed door carries cross-subject refusal, revision CAS and a
transcript projection the generic engine path does not reproduce.
