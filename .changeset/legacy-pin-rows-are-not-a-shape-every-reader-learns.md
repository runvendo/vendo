---
"@vendoai/apps": patch
---

Every app-document read stops reinterpreting pre-split demo rows.

`classifyLegacyPlacements` rewrote a stored `pins` entry whose `base` matched no
captured baseline into `doc.placements` on the way out. It ran on ten read paths
— `owned`, `list`, the files-first save, the review queue, the served snapshot,
the venue-state re-read, the two approval surfaces, and inside both optimistic-
concurrency `JSON.stringify` comparisons — so every reader of an app document had
to know a shape only stale demo rows could have.

Nothing produces that shape. The one writer was demo-bank's `/api/demo/pin`,
deleted when placement became a first-class Vendo write; `pins.fork` and
`pins.rebase` only ever record a captured baseline's own hash. Its output field
is dead too: a placement is a `vendo_placements` row now, and no read mounts from
`doc.placements`. For every row the runtime can write the shim was already the
identity function, so no behaviour changes.

A stored row still carrying the old shape now reads as what it says it is: a pin
whose baseline is gone. It reports drift, it enters the ship diff, and it fails
the export gate — instead of being silently reinterpreted.
