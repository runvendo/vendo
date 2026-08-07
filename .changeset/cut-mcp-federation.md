---
"@vendoai/mcp": minor
"@vendoai/vendo": minor
---

Remove the MCP login-federation handshake and the `remoteAs` external
authorization-server trust mode.

`createMcpDoor` no longer accepts `remoteAs` or `federation`, and the
`{mount}/federate` route is gone. `createVendo({ mcp: { … } })` drops the
matching pass-through fields, and with them the Cloud-managed MCP broker seam
(the ensure-tenant client, the broker selection, the `"broker"` /status
posture, the dev-only `/doctor/mcp` probe, and doctor's hosted-broker line).

Every MCP door now serves its own OAuth authorization server. Pre-1.0 hard
cut: no deprecation shim.
