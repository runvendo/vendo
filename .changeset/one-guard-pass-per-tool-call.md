---
"@vendoai/guard": patch
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

A tool call is decided once instead of twice. Every guarded call ran the whole
policy pipeline twice for one logical call: the harness previews with
`previewCheck` before it dispatches, and the guard-bound registry then evaluated
the same call again from scratch moments later — the grants read, the approvals
read, the rules, the org layer and, worst of all, the judge (up to 15 seconds,
paid twice). The preview's verdict now carries to the dispatch that follows it,
single-use and pinned to that exact call: same id, same arguments, same
descriptor, same subject, venue, presence and app, or it is decided fresh.

Nothing the guard refused before gets through. The preview was always the whole
evaluation — it just never SPENT anything — so the dispatch is what commits, and
a verdict only answers for the dispatch moments behind it: it expires after five
seconds, and every gate that can still stop the call is re-read before anything
is spent. The kill switch is read first, so a freeze landing between the two
passes no longer burns the human's single-use yes on a call it then blocks. The
call-rate window and the write budget are read live and can still park a
previewed "run" that a concurrent call has since put over budget. The org-admin
layer is consulted again, so an admin who tightens the layer while a call sits
previewed clamps that call. The risk GRADE is re-resolved rather than remembered,
so a tool that previewed as `read` and re-grades to `destructive` cannot reach an
away run on the old label — THE LAW's unattended gate never reads a stale grade.
A standing grant is re-read and the single-use yes is claimed last, after every
gate above, so a call that does not proceed spends nothing. Any of these voids
the verdict and the full pipeline decides again. An "ask" is never carried
forward at all — the tap that answers it IS the fresh verdict the dispatch reads.

The judge is asked once per call, so a subject's outstanding previewed verdicts
are voided the moment ANY call for that subject lands — at any risk grade, in any
run or session. The judge decides on the audit trail, and that trail is the
subject's, not the run's: a step whose tools were all previewed before any of them
dispatched would otherwise let the second call run on a verdict taken before the
first one existed, and a landed read or a landed connector call is exactly the
shape a judge most wants to weigh. Sequential calls — preview, then dispatch with
nothing in between — have no outstanding verdict to void and keep the single pass.

Host-API calls also ride the keep-alive connection pool the store already uses.
Node's stock dispatcher drops an idle socket after ~4s — shorter than the gap
between two of an agent's tool calls — so nearly every host round trip was paying
a fresh TCP+TLS handshake. Inference rides the same pool: the composed model
seats now dial the Cloud gateway through it, so a turn does not re-handshake
after every idle gap. A host that passes its own `fetch` — or its own ai-SDK
model object — still wins.

A refused connect check costs one broker lookup instead of two. The connect gate
runs twice for one tool call — the harness preflight rules a call to an
unconnected service out before an approval can be minted for it, and the
gate-wrapped registry rules it out again on the doors that never preview — and
only the CONNECTED answer was cached, so every unconnected call asked the broker
twice to say the same no. A negative answer is now trusted for one second: long
enough for the two checks of one call, far short of an OAuth round trip, so a
user who just connected is never told otherwise.
