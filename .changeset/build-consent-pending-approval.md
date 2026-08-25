---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

An escalated build asks on the standard consent protocol instead of answering
as a success.

`vendo_make` used to return a `status: "ok"` receipt reading
`"awaiting-consent"` when the screen agent escalated to the builder, so the
parked approval was invisible to everything that routes on the outcome: no
in-thread approval card, and an outside agent over MCP was handed plain success
for work nobody had authorized. It now returns the ordinary
`pending-approval` outcome — which is what publishes the `data-vendo-approval`
part the thread renders the card from, and what the MCP door maps to its
approval-ref result.

`ToolOutcome`'s `pending-approval` gains two optional fields for the tool that
parks an ask of its OWN: `approval` (`{ id, question, notes }` — the ask in
words, for a surface that renders no card) and `say` (the assistant's sentence
meanwhile). Both are optional and additive; every shipped producer and reader
is untouched.

Such a card also now SURVIVES the turn. A parked call is swept denied at turn
end so a live-but-dead card cannot accrete in the queue — which, for a build,
tombstoned the app the moment the turn that asked for it ended.

`MakeReceipt.status` drops `"awaiting-consent"`; nothing produces it any more.
