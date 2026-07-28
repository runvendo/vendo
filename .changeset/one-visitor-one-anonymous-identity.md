---
"@vendoai/ui": patch
---

One visitor, one anonymous identity — consent-gated actions stop failing silently.

An anonymous visitor's identity IS the opaque session pointer the door mints on a
cookie-less wire request, and the door mints one PER REQUEST. A cold page load
mounts several hooks at once (`/status`, `/approvals`, `/automations`,
`/activity`, `/connections/catalog`, `/connections`), so every one of them left
cookie-less and minted its own subject; the browser's jar kept whichever
`Set-Cookie` landed last and the rest were orphaned. Measured live: one page load
produced four distinct subjects, three orphaned.

The damage lands on the trust mechanism at the centre of the product. An agent
run created its consent approval under one subject, the user's Approve arrived as
another, and guard correctly refused another subject's approval — surfacing as
`Approval apr_… was not found` and a run stuck on "waiting for your approval"
forever. Every consent-gated action failed this way, and the same split emptied
the activity feed mid-run.

The browser is the visitor boundary, so `createVendoClient` is the layer that can
close the race honestly: the first request through a client may leave
cookie-less, and every request issued before it answers now waits for it and
travels with the pointer it established. Costs one extra round trip on a cold
load and nothing afterwards; a failed first request releases the gate rather than
holding it, so the old behaviour is the floor, never something worse.

Deliberately NOT solved by fingerprinting the requester (IP/User-Agent would
merge two real visitors behind one NAT into a single session, sharing threads,
grants and approvals) nor by deriving the pointer from request attributes (that
would make a live session guessable, where today it is a 2^128 search). Hosts
that already mint the pointer on their document response keep working unchanged —
the door treats a pre-established pointer as canonical.
