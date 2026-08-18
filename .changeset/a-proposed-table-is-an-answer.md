---
"@vendoai/core": patch
"@vendoai/store": patch
"@vendoai/vendo": patch
---

A store that asks for a table gets one. Vendo Cloud's typed data plane answers
the first write to an undeclared table with `409 {error: "schema-proposal",
proposal}` — the DDL that would make the write legal — and the SDK could not
read it: the body's `error` is a string, the wire envelope requires an object,
so the parse failed, the bare status took over, and the caller got "conflict —
store wire request failed with HTTP 409" with the server's proposal erased. Every
app's first row write to a new collection failed, on Cloud, with nothing in the
error to say why.

The store client now declares what it can read on every request
(`x-vendo-store-capabilities: schema-proposal`, scoped to store traffic — no
other wire grows a header), confirms a proposal on the mount's schema door and
replays the write under the SAME idempotency key, so one logical mutation stays
one. It loops for the multi-step case (create_table, then add_column) and stops
after three rounds; a proposal on an operation that names no app is never
confirmed against a guessed one. Both readings of a store failure recognize the
proposal, so the StoreAdapter façade — the surface an app's own writes take —
heals exactly like the op client.

Independently: `parseStoreWireError` stops discarding bodies it cannot parse. An
unrecognized error body now rides a bounded snippet in the message, and a schema
proposal reads as the new `schema-proposal` error code with the proposal intact
on `detail` — so the next protocol skew is diagnosable from the error alone
instead of from a live repro.
