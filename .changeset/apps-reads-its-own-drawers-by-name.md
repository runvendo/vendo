---
"@vendoai/apps": patch
---

Vendo's own drawers are reached by name, not through the generic records door.

Every internal collection `@vendoai/apps` owns — app rows, app grants,
placements and their slot pointers, app tokens, the slot registry, the capped
version log, the parked egress and action cards, in-client approvals, remix
rejections — now goes through the store's named `engine` family
(`ops.engine.get/put/delete/list/claim/insertIfAbsent/compareAndSwap`) instead
of `store.records(<collection>)`. Same collection, same verb, same arguments,
same order; `assertEngineCollection` gates the name on every one of them, so a
drawer this block has no business in cannot be reached from here at all.

The one dynamic collection name is composed by core's `engineAppHistory(appId)`
builder rather than assembled at a call site, so a name that could not pass the
gate is never built in the first place.

Two consequences worth naming. The placement store drops its no-atomic
fallbacks: `claim`, `insertIfAbsent` and `compareAndSwap` are contract on every
engine verb set, so the read-then-write concession a BYO adapter used to get has
nothing left to concede, and the slot arbitration is now always one decision.
And a store that offers neither its own ops surface nor a SQL handle refuses at
the first app-row operation with `not-implemented` naming what to configure,
rather than silently persisting through an ungated façade.

Generated-app data is unaffected: it belongs to the `appData` family, which
stamps an owner, and `vendo_state` stays on the store façade.
