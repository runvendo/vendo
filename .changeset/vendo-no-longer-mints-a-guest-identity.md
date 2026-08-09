---
"@vendoai/core": minor
---

Vendo no longer mints a guest identity. Every wire request must resolve a
`Principal` through the host's own `principal(req)` — there is no more
null-means-anonymous fallback. A `createVendo` composition with no
`principal` (and no `auth` preset, which supplies one) throws `VendoError`
at construction time, naming the missing line. A resolver that returns
`null` for a given request now refuses that request with `forbidden` (403)
instead of minting an ephemeral session. Pre-1.0, hard cut, no shim.

Removed entirely: the `sessions` option on `createVendo`, the
`vendo_sessions` table and its session registry, and the TTL sweep that
expired idle anonymous sessions. The store wire drops four doors —
`lifecycle.adopt`, `sessionRegister`, `sessionStale`, `sessionClaim` — going
from 31 ops to 27. There is no anonymous-to-signed-in merge anymore;
identity is whatever the host's resolver says it is, from the first
request.

Hosts that relied on the zero-config default (no `principal`, no `auth`)
need one explicit line:

```ts
principal: () => ({ subject: "dev" })
```
