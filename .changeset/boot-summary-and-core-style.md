---
"@vendoai/core": minor
"@vendoai/vendo": minor
---

`createVendo` prints one block when it finishes composing, and the palette it
paints with becomes a core primitive.

A deployment used to boot in silence. Which store it composed, which sandbox,
whose model key it picked up and which auth story was actually live were all
knowable only by reading `/status` or the source — which meant the answer arrived
after something had already gone wrong. The boot summary says it once, to the
operator, at the moment it becomes true: one row per seam that is really serving,
naming the venue it chose and the thing that chose it, an environment variable or
the config line the host wrote. A seam nobody filled stays quiet, because silence
is the honest report for a slot a host declined to use.

The block is a single event through core's log sink, so a host can route or
quieten it like any other line, and it can never be split across streams or
arrive interleaved with something else. It is composed facts only — nothing in it
stats a path, opens a handle or awaits anything, so `createVendo` stays I/O-free
at module init and keeps working on Workers. The one judgment that genuinely
needs the filesystem, whether the data directory survives a redeploy, is made by
the seam that owns it and arrives here as data.

`vendoStyle()` and `VendoStyle` move into `@vendoai/core`: one palette and one
`pretty` decision, reachable from packages that sit below `vendo`, instead of
each caller keeping its own copy of the same four helpers.

`HostAuthPreset` gains an optional `name`, which is how the auth row can say
`clerk` instead of just "a preset". It is display only — nothing branches on it,
a preset a host composed itself has no vendor to name and says so rather than
borrowing one, and a name that is not an identifier is not rendered at all.
