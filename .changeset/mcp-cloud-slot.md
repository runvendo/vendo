---
"@vendoai/vendo": minor
"@vendoai/mcp": minor
---

Zero-setup MCP over Vendo Cloud, and one method to mint a user's token.

The mcp seam gains its Cloud rung, in the shape every other Cloud-backed seam
already has (`selectConnections`): an explicit `mcp.remoteAs` wins verbatim, the
declared `VENDO_MCP_BROKER_URL` / `VENDO_MCP_FEDERATION_SECRET` pair wins next,
then `VENDO_API_KEY` lets the console provision the tenant's broker, federation
secret and service key, and a keyless deployment stays exactly the local door it
was. Provisioning is LAZY — composition still does no I/O, so a console outage
cannot stop a deployment booting; the first discovery hit, door hit or
`tokenFor` fetches the bundle and the process caches it. A deployment that
already sets `VENDO_API_KEY` and `mcp: true` moves from a local door to its
Cloud-brokered one on upgrade; declare the env pair (or pass `mcp.serviceAuth`)
to keep the door you have.

`vendo.tokenFor(request | userId)` is the whole new public API: one short-lived
MCP access token bound to one of your users, so a backend agent connects to your
door as them, under the same guard and audit trail as the in-product agent. Pass
the incoming `Request` and the user is read off its session cookie through the
same seam the door authenticates with; pass an id to mint headlessly. Where the
exchange happens is the deployment's posture, not the caller's problem — Cloud
exchanges at the provisioned broker, BYO at the door's own `/token` — so the
same agent code works against both. A blank or literal `"undefined"` subject is
now refused, at `tokenFor` and again at the door's token endpoint, naming the
fix: a token minted for a user nobody is would work perfectly and only fail much
later, as a tool call that finds no data.
