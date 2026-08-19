---
"@vendoai/mcp": patch
---

A long tools/call now survives an external MCP client's clock. The door emitted
no progress at all, so a stock SDK client abandoned `vendo_make` at its 60s
default while the door was still working. The door now beats
`notifications/progress` for the life of the call — immediately, then every 15
seconds — but only for a client that asked to be kept alive by sending a
`progressToken`. Beating is the half the door owns; the client owns the other,
because the SDK extends its deadline on a progress frame only when the caller
passed `resetTimeoutOnProgress`, which defaults to false. `your-own-agent` now
documents both. The beat rides the standalone stream rather than the request's
own, because the door answers POSTs with `enableJsonResponse` and the transport
drops a request-related notification when there is no SSE body to write it to.

Malformed arguments to the `vendo_apps_*` ride-along tools can no longer mint a
parked approval. Validation ran after the guard, so a call that could never
execute — `vendo_apps_call` with no `ref`, say — left an approval waiting in the
queue for a human to resolve. Arguments are now judged first, and a bad one
comes back as a `validation:` error with no approval and no audit row.
