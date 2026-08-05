---
"@vendoai/apps": patch
---

A READ through the app door takes the query arm, so an approved read's refetch
lands.

`apps.call` handed every call to `caller.call` — the arm with a random uuid per
invocation. The guard's approved replay PINS the call id, so an ungraded read
that parked on an approval could never be satisfied: approve, refetch, new id,
park again, forever. It never surfaced because a `.vendo` screen's reads go
through `createProgressiveQueryResolver`, which already calls `callQuery`;
`apps.call` is the only door a code-land app (`@vendoai/kit`'s `useToolQuery`)
has, so the wrong arm became reachable the moment code-land shipped.

A call whose tool is graded `read` now takes `caller.callQuery`, whose id is
derived from (app, tool, args) — exactly a query's identity. The discriminator is
the tool's own authored risk grade, which is the server's existing classification
of what a call does, so nothing new has to be declared and no second route
appears. Every other grade (including `ungraded`) keeps the action arm: two
identical mutations are two separate acts and each has to earn its own approval.
