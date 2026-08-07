---
"@vendoai/vendo": patch
---

An explicit `mcp.serviceAuth` keeps the door's own token endpoint. Setting it is a
choice of LOCAL authorization server — the RFC 8693 exchange it opens exists only
at the door's own `{mount}/token`, which a broker-fronted door does not serve — so
a declared `VENDO_MCP_BROKER_URL` no longer displaces it. That variable is a
default, and a default never overrides what the composition passed.

A deployment that set both used to compose a broker-fronted door and log a warning,
which is the whole failure: the host's configured service-key exchange 404'd at
runtime with nothing but a boot-time line explaining why, and the backend calling it
saw only `not-found`. The broker URL is still parsed either way, so a malformed one
keeps failing loudly rather than dropping to a local door by accident. An explicit
`mcp.remoteAs` alongside `mcp.serviceAuth` is unchanged: `remoteAs` wins and the
warning now names it as the one thing to drop.
