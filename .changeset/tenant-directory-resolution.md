---
"@vendoai/core": minor
"@vendoai/vendo": minor
---

With `VENDO_API_KEY` set and no `auth.memberships` of your own, the SDK now
resolves the acting user's companies from the tenant directory in Vendo Cloud,
cached 60s per user — and everything that already reads `RunContext.memberships`
(app sharing, the `org:<id>` limiter pool, org workspaces) starts working with
no host code. A host that asserts its own `memberships` is untouched: the
assertion wins, and the directory is never constructed. Per-tenant caps set in
the console are enforced by the limiter that already exists; on a store with no
meter they simply do not compose, rather than refusing to boot. A directory
outage serves the last answer, or none — never a failed turn.

`TenantDirectoryPayload`, `TenantLimits`, `TenantCap` and their zod schemas are
new in `@vendoai/core`; `cloudDirectory`, `tenantLimits` and `createLimiter` are
new on `@vendoai/vendo/server`.
