# @vendoai/apps

`@vendoai/apps` owns Vendo app documents, their instant tree surfaces, and sandbox-backed server execution.

## Machine tool proxy

Pass `proxyUrl` to `createApps()` and mount `runtime.proxy.handler(request)` at that URL. New machines receive the URL as `VENDO_PROXY_URL`; when `proxyUrl` is omitted, machines run without host-tool access.

All proxy routes require `Authorization: Bearer $VENDO_RUN_TOKEN`. Mutation routes also require `content-type: application/json`.

- `POST /tools/<name>` with `{ "args": ... }` calls the guard-bound host tool registry and returns its `ToolOutcome` unchanged, including `pending-approval`.
- `GET /state` reads the `vendo.state` value scoped to the token's app and user.
- `PUT /state` replaces that scoped state with the request's JSON body.

Run tokens are short-lived (15-minute TTL) and scoped to one app, user subject, presence mode, and run id.

## Secrets

Declared secrets never enter a machine as values: each is injected as an opaque `vendo-secret:<name>:<nonce>` handle, so app code (`process.env.STRIPE_KEY`) only ever holds the handle. This package ships `substituteSecretHandles()` — the pure, allowlist-gated substitution the egress boundary uses to swap a handle for its real value only toward an app's allowlisted hosts.

**v0 limitation (flagged):** wiring that substitution into the actual outbound path requires an in-sandbox egress proxy — the frozen `SandboxMachine.request()` seam models host→machine (inbound) traffic, not machine→internet (outbound). So in v0 the handle injection (the security property: values never reach app code or exports) is complete, but a handle transiting toward an allowlisted host is not yet auto-resolved. Don't rely on secret handles resolving until the in-sandbox proxy lands.

## Sandbox adapters and snapshots

`@vendoai/apps/e2b` and `@vendoai/apps/modal` implement the `SandboxAdapter` seam. Two v0 limitations, both provider-inherent and flagged in the adapter source:

- **Run-env at resume**: the frozen `resume(ref)` seam takes no environment, so a machine woken from a long-slept snapshot keeps its snapshot-time `VENDO_RUN_TOKEN` (which may have expired) and secret nonces. Refreshing per-run auth on resume needs an additive seam extension. Present-mode and short runs are unaffected.
- **e2b snapshots are single-instance**: e2b pause/resume is one recoverable state (resume unpauses the same sandbox). A non-destructive read-for-export needs adapter-side clone support e2b doesn't expose in v0, so exporting a server-backed app is a Modal-first path (its image snapshots are non-destructive); the in-process fake adapter proves the export/import contract. **Modal** JS snapshots are disk-only (restore builds a new machine and re-runs the start command; images expire in ~30 days), and restore-options currently live per-adapter-instance — durable cross-process restore is a fast-follow.

`@vendoai/apps/cloud` reserves the same adapter seam for Vendo Cloud. The OSS v0 export is an explicit `cloud-required` stub; the hosted implementation will provide adapter-level `create`/`resume` and machine-level `request`/`exec`/`files`/`snapshot`/`url`/`stop` over that frozen interface.
