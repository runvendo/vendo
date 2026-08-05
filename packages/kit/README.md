# @vendoai/kit

Provides the runtime a generated Vendo app imports inside its own box: the Kit
components and formatters, the reshape and aggregate vocabulary, and the guarded
data, action, and state hooks.

Every export is the machinery Vendo already runs, wrapped for code — the same
components a `.vendo` screen renders, the same `$expr` engine its totals compute
through, and the same guarded door (`POST /apps/:appId/call`) its actions call.
An app mounts `<VendoAppProvider>` once at its root; the provider reads which app
it is from the URL the wire serves it at.

Read [Generated UI](https://docs.vendo.run/concepts/generated-ui).
