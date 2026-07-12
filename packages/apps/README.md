# @vendoai/apps

`@vendoai/apps` owns Vendo app documents, their instant tree surfaces, and sandbox-backed server execution.

## Machine tool proxy

Pass `proxyUrl` to `createApps()` and mount `runtime.proxy.handler(request)` at that URL. New machines receive the URL as `VENDO_PROXY_URL`; when `proxyUrl` is omitted, machines run without host-tool access.

All proxy routes require `Authorization: Bearer $VENDO_RUN_TOKEN`. Mutation routes also require `content-type: application/json`.

- `POST /tools/<name>` with `{ "args": ... }` calls the guard-bound host tool registry and returns its `ToolOutcome` unchanged, including `pending-approval`.
- `GET /state` reads the `vendo.state` value scoped to the token's app and user.
- `PUT /state` replaces that scoped state with the request's JSON body.

Run tokens are short-lived and scoped to one app, user subject, presence mode, and run id. Declared secrets enter machines only as opaque `vendo-secret:<name>:<nonce>` handles; sandbox adapters use `substituteSecretHandles()` at egress and only resolve them for an app's allowlisted hosts.
