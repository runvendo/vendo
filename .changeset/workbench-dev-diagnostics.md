---
"@vendoai/harnesses": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

A dev-only workbench diagnostics channel behind `VENDO_WORKBENCH`, and the feed
store that reads it.

`@vendoai/harnesses` reports what a turn is doing about itself — step starts and
ends, guarded tool calls, context and compaction, loadout, hires, errors — on a
transient `data-vendo-debug` part. The gate is `VENDO_WORKBENCH=1` on the
server, read once per turn: unset, no channel is registered, so nothing can
reach the wire and nothing is ever persisted.

`@vendoai/ui` gains the receiving half: `publishWorkbenchPart` files a chunk,
`useWorkbenchFeed` reads the turns back in the producer's own `seq` order, and
`developmentMode` decides whether such a surface renders at all.
`@vendoai/vendo/react` re-exports all three, so a host on the umbrella package
can build the pane without reaching for `@vendoai/ui` directly.
