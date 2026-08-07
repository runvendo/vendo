---
"@vendoai/actions": minor
---

Two actions fixes and a public-surface trim. A failed MCP handshake is no longer cached for the process lifetime: `mcpConnector` clears the memoized `initialize` promise (and the session id) when it rejects, so one transient blip no longer permanently kills every tool that connector serves. The registry's documented evict-on-rejection retry re-entered the same rejected promise and silently never recovered. Component capture now checks the closure byte budget before it walks imports as well as during: an entry file with no capturable host-local import used to be written at any size, so an oversized single-file component reached `.vendo/components/` in violation of the one-total-budget guarantee. Finally, `validateCapabilities`, `CapabilityIssue` and `PrimitiveStepTarget` are no longer re-exported from the package root — they are internal to the compound walker and had no consumer outside it.
