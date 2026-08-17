---
"@vendoai/ui": patch
---

A signed-out visitor sees a quiet panel, not a broken agent. When the wire
refuses a visitor for missing identity, the overlay's launcher still renders —
nothing about wire health hides it — but opening it now shows one
host-brandable line ("Sign in to use the agent.", or the new `signedOutNotice`
overlay prop) instead of a conversation that can only error. The server's
developer-facing resolver message never reaches the surface, and the
conversation returns on `vendo:identity-changed` or the first successful wire
read. Completes the signed-out state the poller latch started.
