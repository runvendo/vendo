---
"@vendoai/vendo": minor
---

Remove tour mode.

Tour mode had no consumer: not the demo host, not the framework examples, not
the docs beyond its own page — only its own tests. The demos that need a
scripted walkthrough each hand-write one against their own host, which is the
shape that actually shipped. Pre-1.0, so this is a hard cut with no shim.

Removed from `@vendoai/vendo/server`:

- the `tours` config option on `CreateVendoConfig` (`tours?: readonly TourEntry[]`)
- the `TourEntry`, `TourResponse`, `TourPart` and `TourApp` type re-exports
- `ScriptedTurn` and the `scripted` seam on `HarnessTurnsConfig`, whose only
  producer was tour mode

A host that passed `tours` gets a type error naming the removed key; there is
no replacement, and no other configuration changes.
