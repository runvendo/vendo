---
"@vendoai/vendo": patch
---

`vendo sync` now finds the wire on a host that is mounted under a path prefix.

The blast-radius probe — the one that answers "what does changing this tool
break?" — addressed the dev server at `<base>/api/vendo`, and with no
`VENDO_BASE_URL` in the environment that base was a bare
`http://localhost:3000`. On a host served under a prefix (Maple runs at
`/maple`, so its wire answers at `/maple/api/vendo`) the request landed on a
path the router never matched, and the probe reported the 404 it caused as
`impact unknown — dev server not reachable`. Every mounted host got that same
wrong diagnosis on every sync, with a running server the whole time.

With no base URL configured the probe now reads the prefix off the OpenAPI
spec's relative server mount — the only other place it is written down, already
how the prefix reaches host tool calls, and the value `vendo doctor` holds
`VENDO_BASE_URL` to agreement with (E-CFG-003). A host with no prefix, or one
whose `VENDO_BASE_URL` is set, is addressed exactly as before.
