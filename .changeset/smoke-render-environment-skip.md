---
"@vendoai/apps": patch
---

Smoke-render gate: treat a module the worker cannot load as an environment failure (skip) instead of an island crash. Under Turbopack `require.resolve("jsdom")` does not throw — it succeeds with a synthetic `[externals]/jsdom [external] (…)` specifier — so the gate's documented "unresolvable → skip silently" path never fired, and the worker's prelude `require` failure was reported as a per-island render crash and routed to repair, which cannot fix a module that will not load. Every generated app carrying an island failed to build. Resolved paths are now checked against the filesystem, and any failure before the worker posts `ready` comes back as an environment failure.
