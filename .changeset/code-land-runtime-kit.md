---
"@vendoai/kit": minor
"@vendoai/ui": minor
---

Add `@vendoai/kit`, the runtime a generated app imports inside its box.

A code-land app now has the same vocabulary a `.vendo` screen has, reaching the
same implementations rather than parallel ones:

- `reshape.{pick,rename,asPoints,format,sum,min,max,count}` — the eight LIVE
  reshape ops, each one call to core's `applyReshape`. The two deprecated ops
  (`asOptions`, `template`) are deliberately not wrapped, and `avg` retired with
  the pipe (#808) — code-land averages through the `average` aggregate below.
- `sum`, `count`, `average`, `min`, `max`, `difference`, `daysUntil`, `groupBy` —
  the aggregates, evaluated by core's `evaluateExpr`. `sum(rows, "amount_cents")`
  runs the code path `sum(invoices.amount_cents)` runs; the seam is asserted
  against `evaluateExpr` directly, so a second implementation cannot appear
  without a test going red.
- `useToolQuery` / `useToolAction` — the guarded read and write over the door
  that already exists, `POST /apps/:appId/call`, through the same
  `createVendoClient` the host's chrome uses. A non-ok outcome contributes no
  data and sets `dataUnavailable`, so a failed load never reads as "you have
  nothing"; a successful action refreshes the screen's queries.
- `useVendoState` — the `$state` binding for code.
- `<VendoAppProvider>` — the one provider, which derives the app id and wire base
  from the URL the wire serves the app at (`<base>/apps/:appId/serve/`), so a
  same-origin call rides the viewer's own session.

`@vendoai/ui` gains two things this needed: the keyed `$state` store is now
`useKeyedState` in `@vendoai/ui/kit`, shared by the tree renderer and code-land
(one implementation, two venues, exactly as `fmt` is), and the wire client is
reachable at `@vendoai/ui/client` so the shim calls the door through the existing
client instead of a second fetch layer.
