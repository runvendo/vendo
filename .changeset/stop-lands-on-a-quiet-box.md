---
"@vendoai/harnesses": patch
---

Stop reaches a sandboxed session immediately, not up to ten seconds later.

The box driver only noticed `turn.signal` between polls, and the box door holds a
poll open for ten seconds when the session has nothing to say. So Stop pressed
during a long tool call — the moment a user actually reaches for it — sat behind
that parked poll before the interrupt was sent. The driver now interrupts from an
`abort` listener the instant the signal fires, matching the local (non-sandboxed)
path, which has always done it this way.
