---
"@vendoai/core": patch
"@vendoai/actions": patch
"@vendoai/apps": patch
"@vendoai/automations": patch
"@vendoai/store": patch
"@vendoai/telemetry": patch
"@vendoai/vendo": patch
---

Edge-runtime portability: the server entry now bundles and boots on
Web-standard runtimes (Cloudflare Workers first). Fetch defaults are
invocation-safe, the optional e2b SDK no longer breaks esbuild/Wrangler
builds, Node-only legs (local store engines, dev model ladder, telemetry
disk config, actions sync tooling) sit behind worker/edge export
conditions with honest guidance, and createVendo performs no I/O, timers,
or random generation at construction — module-scope wiring works. A CI
portability gate (bundle + real workerd boot) keeps it that way.
