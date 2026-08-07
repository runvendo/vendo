---
"@vendoai/actions": patch
---

Sync's scanners stop inventing a delete and stop discarding a props schema.

A `pages/api` handler that switches on a body discriminant —
`switch (req.body.action) { case "delete": ... }` — had every string case clause
counted as an HTTP method, and the verb is upper-cased before it is checked. The
scan handed the agent an ENABLED, `destructive`-graded DELETE tool bound to the
route's real URL for a delete the handler never implements, and because any verb
evidence short-circuits the `req.body` inference below it, that phantom verb
*replaced* the POST the route actually serves. Only an uppercase verb literal
counts now.

Separately, the component catalog scanner failed a whole props object as soon as
one property could not be converted, so a component with a single callback,
`ReactNode`, or npm-typed prop published `propsSchema: {}` for every prop — and
the console then told the host it had declared no props schema at all. One
unrepresentable property now degrades to a permissive `{}` and drops out of
`required`, the same rule the route input converter already applies, so every
prop that converted fine reaches the catalog and previews can draw from them.
