# @vendoai/kit

## 0.8.0

### Minor Changes

- ab5d181: Add `@vendoai/kit`, the runtime a generated app imports inside its box.

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

### Patch Changes

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [4b6e362]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [ab5d181]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [ab5d181]
- Updated dependencies [6224a7e]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [4515c7f]
- Updated dependencies [6eb8a04]
- Updated dependencies [fbf265b]
- Updated dependencies [2ed91b0]
- Updated dependencies [1deaa5c]
- Updated dependencies [e6aaa7a]
- Updated dependencies [d0c3cc9]
- Updated dependencies [798b618]
- Updated dependencies [10a2b44]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [fbf265b]
- Updated dependencies [a004031]
- Updated dependencies [38a840d]
- Updated dependencies [a0dbfc6]
  - @vendoai/core@0.8.0
  - @vendoai/ui@0.8.0
