---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/ui": minor
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

`ToolOutcome`'s `pending-approval` gains three optional fields for the tool that
parks an ask of its OWN: `descriptor` (the ask's own — what a CARD derives its
words from), `approval` (`{ id, question, notes }` — the same ask already in
words, for a surface that renders no card) and `say` (the assistant's sentence
meanwhile). All three are optional and additive; every shipped producer and
reader is untouched.

The descriptor rides the `data-vendo-approval` part, so the in-thread card is
graded and worded off the BUILD. Graded off the calling tool it read
`vendo_make`'s "read", and told a person that spending a build machine reads
their data. And because a standing ask has no parked native call to render
from — nor may it have one, since the runtime abandons every still-parked ask
at the next turn — the thread now paints the shipped `ApprovalCard` from that
part directly, deciding over the wire like the queue and the toast, with no
`remember` disclosure. Before this the transcript showed only the calling
tool's beat, "wasn't allowed", for a question nobody had been asked yet.

Such a card also now SURVIVES the turn. A parked call is swept denied at turn
end so a live-but-dead card cannot accrete in the queue — which, for a build,
tombstoned the app the moment the turn that asked for it ended.

An answered card SETTLES, and the assistant stops talking over it. In-thread
consent cards resolve into the settled record on decide — including a decide the
wire says was already answered (or swept), which used to leave the buttons live
under an error on a closed question. And `say` is now the refusal the harness
hands the model for a tool that parked its own ask, so the model relays the one
sentence the door wrote ("I've asked for your go-ahead — the card above has the
details.") instead of narrating its own paragraphs under a card that is already
asking.

`MakeReceipt.status` drops `"awaiting-consent"`; nothing produces it any more.
