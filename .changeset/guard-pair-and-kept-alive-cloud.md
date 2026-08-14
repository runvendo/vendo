---
"@vendoai/guard": patch
"@vendoai/vendo": patch
---

Two round trips become one, and a Cloud connection survives the gap between tool calls.

Every guard decision paid its two bookkeeping lookups — is there an approved
replay for exactly this call, and is there a matching standing grant — strictly
one after the other, even though they read different collections and neither
consults the other's answer. They now go out together. Precedence is untouched:
the replay verdict is still read first, the grant only after it, and the
single-use CAS spend still happens exactly once. Against a Cloud-hosted store
the pair's p50 drops from ~400ms to ~250ms.

Separately, the Vendo Cloud adapters (`hostedStore`, `cloudSandbox`,
`cloudConnections`, `cloudTools`) had no connection pooling of their own, so
they inherited Node's stock dispatcher — which drops an idle keep-alive socket
after about four seconds. That is shorter than the gap between two of an
agent's tool calls, so nearly every Cloud round trip paid a fresh TCP+TLS
handshake: measured against console.vendo.run, five reconnects in five calls
across a six-second idle gap. Their default `fetch` now rides one shared pool
that holds a connection for a minute — zero reconnects across the same gap, and
~85ms off an after-idle store read. A host passing its own `fetch` still wins,
exactly as before, and the pool is Node-only by construction: an edge/Worker
target that cannot load undici keeps today's plain fetch.
