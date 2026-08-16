---
"@vendoai/vendo": minor
"@vendoai/guard": minor
---

Config resolves in code, forever — and the console only ever hears about it.

Per surface, resolution is now exactly: a value passed in code → the local `.vendo/<name>` file → not set. The console is out of resolution entirely. The hosted-config client that made a console-published value a third rung is deleted, along with every leg that read it: the brief resolver, the theme and design-rules providers, the merged tool semantics, the guard's policy fallback, and the actions registry's cloud overrides-enablement fetch. A deployment's config can no longer change underneath it because someone published in a browser, and a keyed boot no longer makes a blocking config read before it can serve a tool.

BREAKING. `cloudConfig` and its types (`CloudConfig`, `CloudConfigDoc`, `CloudConfigResult`, `CloudConfigOptions`) are gone from the package root. `ConfigSurfaceOwner` loses its `"cloud"` member, and `SelectConfigSurfaceInput` loses `cloud`. `@vendoai/guard`'s `policyCloudFallback` option is gone — nothing can fill it now. The CLI's `vendo config push` and `vendo config pull` (and the `--draft`, `--yes`, `--key`, `--api-url` flags they carried) are gone; `vendo config status` is local-only, reports `file` / `unset`, and makes no network call and needs no credential. `vendo doctor` no longer downgrades a missing `.vendo` config file to a warning when `VENDO_API_KEY` is set — a missing file is a missing file for every deployment.

In its place, a keyed runtime REPORTS the config it resolved to, one way and lazily: `PUT /api/v1/config/report` (204 No Content) carrying all five surfaces as `{ source: "file" | "code" | "unset", content }`, pushed through the existing batched uploader on the deployment identity every keyed call already carries. It fires at boot and again only when the resolved surfaces actually change — no heartbeat, no timer, no new transport. Keyless deployments report nothing, ever.
