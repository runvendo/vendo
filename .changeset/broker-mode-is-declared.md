---
"@vendoai/vendo": minor
"@vendoai/mcp": patch
---

Broker mode is DECLARED, not discovered. Set `VENDO_MCP_BROKER_URL` to your tenant's
MCP endpoint (`https://acme.mcp.vendo.run/mcp`) and the door trusts that broker:
the URL's origin is the issuer, the URL itself is the expected token audience,
and `VENDO_MCP_FEDERATION_SECRET` answers its login handshake. An explicit
`mcp.remoteAs` still wins.

This replaces the boot-time ensure-tenant call a `VENDO_API_KEY` plus a public
`VENDO_BASE_URL` used to make: the app no longer writes its own address to Vendo
Cloud, so whichever process booted last can no longer decide where the broker
forwards, and a failed call can no longer silently swap a deployment to a
different authentication architecture for the life of the process. A
`VENDO_API_KEY` now has no effect on MCP at all, and a malformed `VENDO_MCP_BROKER_URL`
fails the composition loudly instead of quietly reverting to a local door.
