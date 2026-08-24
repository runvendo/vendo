---
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/vendo": minor
"@vendoai/store": minor
"@vendoai/ui": minor
---

Retire the persistent per-app machine surface. A built app is now a sealed bundle the host serves, so nothing needs a machine that outlives the build: the `AppsRuntime.machine` lifecycle doors (`available`, `ping`, `report`), the §9.8 served-app proxy (`AppsRuntime.serve`, `GET /apps/:id/serve/**`), the editor-level box door (`AppsRuntime.box.request` / `.redact`, `POST /apps/:id/fn/:name`), the whole `/box/*` callback surface with its per-app bearer, and the embed keepalive (`POST /apps/:id/machine/ping`, `client.apps.pingMachine`) are all gone. The `ui` package loses `HttpFrame` and its keepalive wiring; `BundleFrame` and `bundleUrl` are what render an app now. `@vendoai/box-template` is deleted — the box image no longer bakes a per-app web template, and its harness keeps only the session half. `vendo_app_tokens` leaves the engine allowlist (v9), and the store's promote no longer re-owns a bearer that no longer exists. `packages/apps`' `prewired-schema` moves to `server/checking/`, beside the validator that reads it.
