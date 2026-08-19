---
"@vendoai/core": minor
"@vendoai/vendo": minor
---

With `VENDO_API_KEY` set and no memberships seam of your own, the SDK now
resolves the acting user's companies from the tenant directory in Vendo Cloud,
cached 60s per user — and everything that already reads `RunContext.memberships`
(app sharing, the `org:<id>` limiter pool, org workspaces) starts working with
no host code. Per-tenant caps set in the console are enforced by the limiter
that already exists; on a store with no meter they simply do not compose, rather
than refusing to boot. A directory outage serves the last answer, or none —
never a failed turn.

Caps reset on the calendar boundary in UTC, not on a rolling lookback:
`messagesPerDay` refills at UTC midnight and `generationsPerMonth` on the first
of the month, so a message sent at 23:59 does not spend the next day's
allowance.

`memberships` is now also a top-level `createVendo` key, the per-seam twin of
`auth.memberships` for hosts on the `principal` trio — the same precedence
`actAs` and `oauth` already have. Assert it and it wins outright: no Cloud
client is constructed and no request ever calls out.

That twin is also how a keyed deployment declines the directory. If you set
`VENDO_API_KEY`, use `principal` rather than an `auth` preset, and have no
orgs, say so once and Vendo will never ask Cloud:

```ts
createVendo({
  principal: async (req) => …,
  memberships: async () => [],
})
```

Without that line, such a deployment resolves memberships from Cloud — one
cached call per user per minute, and, until your project has tenants, a log
line saying the directory had nothing to say.

`TenantDirectoryPayload`, `TenantLimits`, `TenantCap` and their zod schemas are
new in `@vendoai/core`; `cloudDirectory`, `tenantLimits` and `createLimiter` are
new on `@vendoai/vendo/server`.
