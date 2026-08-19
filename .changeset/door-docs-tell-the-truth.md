---
"@vendoai/vendo": patch
---

Docs: the door pages say what the door does.

Four published statements were false. `custom-tools` claimed a hand-written tool
is projected exactly like an extracted one — an authored `surfaces.mcp` menu is
an allowlist of exact names, and a tool of yours that is not on it is not at the
door, while `vendo_*` tools bypass the menu by prefix. `how-the-door-works` gave
the `tools/list` answer unconditionally when that answer is the no-menu default,
and enumerated the ride-along `vendo_*` tools without the three user-files ones.
`tenant-connectors` handed out a legacy `/sse` URL to paste, twice; the connector
POSTs JSON-RPC to one Streamable HTTP URL and speaks no HTTP+SSE at all.
`handler-options` described `files:` as somewhere content lives past 5 MiB, which
reads as tiering — there is one backing and no spillover.

PKCE was documented nowhere. The door's authorization endpoint requires it and
accepts `S256` only, and a code is claimed the moment it is presented, so a
mismatched verifier burns it. Both are now on the HTTP reference.

New, for what shipped: the three file tools at the MCP door with their risk
grades and per-user scoping, the read window, the exact list of extensions that
read back and the refusal for everything else, `uploadMaxBytes` as a door cap
with its over-cap sentence, and `s3Files` for R2 / S3 / Supabase / MinIO.
