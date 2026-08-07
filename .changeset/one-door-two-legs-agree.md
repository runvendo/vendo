---
"@vendoai/mcp": patch
---

Four fixes on the MCP door: expired turn credentials, RS256 tokens, blank
`remoteAs` bindings, and MCP Apps on the turn-credential leg.

**An expired turn credential no longer comes back to life.** `publish()` refreshed
the idle expiry of every credential minted for the thread without checking whether
it had already lapsed, and expiry was only ever evaluated lazily inside `resolve()`.
A token whose conversation went quiet past the idle budget was therefore dead only
if someone happened to resolve it; if the conversation took another turn first, the
expiry was pushed forward and the token worked again. Lapsed entries are now dropped
in that same loop, across the whole registry rather than only the thread being
published, which also bounds it in a long-running host process — a token minted for
a conversation that never takes another turn previously had nothing to remove it.

**`remoteAs` accepts the algorithms real authorization servers use.** Verification
was pinned to ES256 alone, so a door pointed at Auth0, Okta, Entra ID or Cognito —
all of which issue RS256 by default — returned 401 on every request with no local
`/authorize`, `/token` or `/register` to fall back to. The allowlist is now
`RS256/384/512`, `PS256/384/512` and `ES256/384/512`; symmetric algorithms and
`none` stay rejected. Separately, a blank `remoteAs.issuer` or `audience` now fails
at `createMcpDoor` instead of silently disabling the claim check it names.

**Opening a saved app over a turn credential renders.** One door composed with both
`apps` and `turnCredentials` — which is every `createVendo({ mcp: true })` — made
apps render on the OAuth leg only. The turn leg advertised no shim resource on its
`vendo_apps_*` listings and returned the registry's raw `OpenSurface` envelope with
the already-resolved query declarations still in it. Both legs now run the same two
steps.

Revoking a client no longer scans every outstanding authorization code in the
deployment. That scan looked for codes carrying no grant family, which the only
code-minting path cannot produce.
