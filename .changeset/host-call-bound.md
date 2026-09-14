---
"@vendoai/vendo": patch
"vendoai": patch
---

A host tool call is bounded at 30s (`HOST_REQUEST_TIMEOUT_MS`), transport and body
together. A host route that never answered held the tool call — and the turn
awaiting it — open indefinitely: nothing above `fetchHostTool` bounds a tool, and
the turn's own abort never reaches a host fetch. The timed-out call now comes back
as the ordinary `network-error` outcome, naming the bound.
