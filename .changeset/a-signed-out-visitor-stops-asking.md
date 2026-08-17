---
"@vendoai/ui": patch
---

A signed-out visitor's chrome stops asking. On a preset-authed deployment
every wire call for a visitor with no session correctly answers forbidden —
and every poller retried it forever, filling the console with 403s. A
forbidden refusal is now a full stop for every poller (the shared resource
loop, the approvals feed, the slot/placements poller and its report writes,
the parked-press backstop), a tab switch does not resurrect them, and the
app-open retry ladder no longer burns its attempts on a refusal that cannot
change. Everything wakes together when the host dispatches
`vendo:identity-changed` after an SPA sign-in (a full-page redirect remounts
everything anyway), or the moment any wire read succeeds again.
