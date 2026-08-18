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
it commits the same things in the same order: the call-rate window and the write
budget are read live and can still park a previewed "run" that a concurrent call
has since put over budget; the human's single-use yes is claimed by the pass that
dispatches, and a claim that loses sends the call back through the full pipeline;
a standing grant is re-read, so a permission taken back between the two passes
still stops the call; the kill switch is re-read uncached immediately before
dispatch, exactly as before; and THE LAW's unattended gate reads the same verdict
and effective descriptor it always did. An "ask" is never carried forward at all —
the tap that answers it IS the fresh verdict the dispatch reads.

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
