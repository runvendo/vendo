---
"@vendoai/ui": minor
---

A build's consent ask stops arriving as a toast popup.

The toast stack polls every pending approval and raises a card for each, so a
build ask reached the person twice: once on the in-thread `ApprovalCard` the
`data-vendo-approval` part paints, and again as a popup over whatever they were
doing. The card is the consent surface — the popup asked the same question a
second time, in a second place, and a yes on either one settled the other.

The toast surface now skips an approval whose call is `vendo_app_build`, and
only that surface: the launcher badge counts it exactly as before, which is what
keeps a closed thread from stranding an ask that outlives its turn.

The build's live status line rode that same toast — it was raised only off the
toast's own Approve — so a build now shows no progress line anywhere. That was
already the case for anyone who answered on the card instead of the popup.
