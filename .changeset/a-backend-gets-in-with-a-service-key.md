---
"@vendoai/mcp": minor
"@vendoai/vendo": minor
"@vendoai/core": patch
---

A host's own backend gets in at the MCP door with a service key — no per-user
OAuth, no browser.

`createVendo({ mcp: { serviceAuth: { keys: [...] } } })` arms the door's own
`/token` endpoint for RFC 8693 token exchange: the backend POSTs
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with
`client_id=vendo-service`, the key as `client_secret`, and one of its own user
ids as `subject_token`, and gets back a ten-minute `vmat_` bearer token for
that user. Keys are opaque strings the host mints itself (`openssl rand -hex
32`); the door stores only their hashes, compares in constant time, and
answers every failure with the same `invalid_client`. No refresh tokens —
rotation is "exchange again." Audit rows carry a `svc:<hash>` client id so
service-minted sessions are distinguishable from interactive ones.
