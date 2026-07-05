# Persistence + Deploy

What survives a restart, how the scheduler stays alive without a browser tab
open, and how to wire Composio triggers — the three things that change once
you take a Vendo install past `next dev` on your laptop.

## The one storage knob

`createVendoHandler({ storage })` is the only setting that matters:

- **Unset (default)** — an embedded PGlite database at `.vendo/data`
  (override the directory with `VENDO_DATA_DIR`). Zero config, file-backed,
  good for local dev and a single long-lived process (Docker, a VPS,
  `next start`). PGlite is single-process by design: on a known-serverless
  runtime (Vercel, Cloudflare Pages, Lambda) the handler refuses to boot on
  this default and tells you to set `DATABASE_URL` instead, rather than
  silently running on an ephemeral filesystem.
- **`storage: { connectionString }` or `DATABASE_URL`** — any real Postgres:
  Supabase, Neon, RDS, a Docker container. Same schema, same code path, just
  a different `pg` connection.
- **`storage: false`** — in-memory. Nothing survives a restart. This is also
  what you get automatically when `NODE_ENV=test` and you pass no `storage`
  option at all — see the single-writer section below, this one bites people.

Migrations run automatically on first boot (`autoMigrate: true` by default),
guarded by a per-process init lock and, on real Postgres, a Postgres advisory
lock so two cold starts can't race the same DDL. Shops that gate schema
changes behind a review process set `storage: { autoMigrate: false }` and
call the exported `migrateVendoDatabase(handle)` (from `@vendoai/store`)
out of band, whenever they're ready to apply it.

All tables live in a dedicated `vendo` Postgres schema — your app's
`public` schema stays untouched.

## What persists

With durable storage on, five surfaces are covered end to end:

- **Automations** — the automation, its versions (each version carries its
  spec and any pre-approved grants), and its run history, all in the
  `automations` / `automation_versions` / `automation_runs` tables.
- **Approval decisions** — the ask-once-remember layer's "already decided"
  memory (`decisions` table), keyed by principal + canonical policy key.
  Separate from automation grants — a decision remembered in chat does not
  feed the unattended automations world, which only ever honors grants.
- **Chat threads** — `threads` + `thread_messages`, upserted by message id so
  an approval resume replaces parts in place instead of duplicating them.
- **Saved vendos** — the shell's saved-vendo library, in `saved_vendos`.
- **Integration connections** — which Composio toolkits are connected (what
  the agent ingests) and the connected-account → principal map webhook
  routing depends on, in the `connections` table. `createVendoHandler()`
  wires `createDrizzleConnectionsStore` in automatically whenever durable
  storage is configured — no separate opt-in. This is what makes Composio
  webhooks survive a restart: without it, every connected toolkit forgot it
  was connected on reboot and every inbound webhook was silently skipped
  until the user reconnected. Pass your own store via the `connections`
  option only if you need to own connection state elsewhere (e.g. a demo
  reset that clears it) — an explicit option always wins over this default.

## Single-writer, single-tenant — read this before deploying

This release does not add multi-instance or multi-tenant support. Two things
to know:

- **One process owns the scheduler and the runner.** Durable storage makes
  state survive a restart, not concurrent writers safe. Automations dedup on
  a `firingRunId` primary key (so a timer/cron overlap or a restart mid-fire
  is a duplicate-key no-op), and approval resume is an atomic conditional
  claim — but full multi-replica coordination (per-automation leases or
  advisory locks) is out of scope. Run the handler as one long-lived Node
  process, not spread across cold serverless instances.
- **A `principal` resolver is an access gate, not tenant isolation.** It
  decides who may call the endpoints; it does not partition the store. Every
  caller still shares one automations-world scope, one connections store,
  one cached-agent set. If you configure a custom `principal` resolver
  together with durable storage, the handler logs a one-time warning about
  this. Every table already carries `tenant_id`/`subject` columns, so
  per-user partitioning is a future behavior change, not a schema migration —
  but it isn't built yet.
- **`NODE_ENV=test` silently disables durability.** If `storage` is left
  unset and `NODE_ENV` is `"test"`, the handler behaves exactly like
  `storage: false` — no warning, no on-disk PGlite directory. This exists so
  running the test suite dozens of times doesn't spray `.vendo/data`
  directories around the repo. Never let `NODE_ENV=test` leak into a real
  deploy: pass an explicit `storage` value (including `false`, if that's
  really what you want) to opt back in under any `NODE_ENV`.

## Scheduler modes

By default, schedules fire from an in-process timer that boots with your
Next.js server — `vendo init` writes an `instrumentation.ts` (or
`src/instrumentation.ts`, next to a `src/app`) that calls
`startVendoScheduler()` from `@vendoai/next` when the Node.js runtime
starts:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startVendoScheduler } = await import("@vendoai/next");
    startVendoScheduler();
  }
}
```

This is the real Next.js boot hook — no request needs to land first. It's
idempotent and safe under dev-mode HMR.

Set `VENDO_SCHEDULER=external` to disable the internal timer entirely
(serverless or multi-instance deploys) and drive ticks from an external cron
hitting `POST <mount>/tick` instead, authenticated with
`authorization: Bearer $VENDO_TICK_SECRET`. Without `VENDO_TICK_SECRET`
configured, remote ticks are refused outright; a wrong bearer is always a
hard 401, never a silent fall-through to the normal principal guard.

**Vercel.** Vercel Cron Jobs only ever send a `GET` request and don't let you
attach a custom `Authorization` header — so point the cron at a tiny relay
route in your own app, and have that route perform the authenticated `POST`
to `/api/vendo/tick`:

```json
// vercel.json
{
  "crons": [{ "path": "/api/cron/vendo-tick", "schedule": "* * * * *" }]
}
```

```ts
// app/api/cron/vendo-tick/route.ts
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/api/vendo/tick`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.VENDO_TICK_SECRET}` },
  });
  return new Response(null, { status: res.ok ? 200 : 502 });
}
```

**Cloudflare Cron Triggers.** A Worker's `scheduled` handler runs arbitrary
code, so it can call the Next.js deployment directly:

```toml
# wrangler.toml
[triggers]
crons = ["* * * * *"]
```

```ts
export default {
  async scheduled(_event: ScheduledEvent, env: { VENDO_TICK_SECRET: string; APP_ORIGIN: string }) {
    await fetch(`${env.APP_ORIGIN}/api/vendo/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.VENDO_TICK_SECRET}` },
    });
  },
};
```

Missed fires are never backfilled: the due-window starts at process boot, so
downtime just means skipped fires, not a catch-up burst when the server comes
back.

## Composio webhooks

`POST <mount>/webhooks/composio` is a signature-verified ingress route for
Composio triggers (Gmail, Slack, etc. firing without polling). To wire it:

1. Set `COMPOSIO_WEBHOOK_SECRET` to the signing secret from Composio's
   dashboard webhook settings (the `whsec_`-prefixed value, verbatim).
2. Point the webhook URL in that dashboard at
   `https://your-deployed-host/api/vendo/webhooks/composio` (adjust the
   mount if you didn't use the default `api/vendo` catch-all path).
3. Without `COMPOSIO_WEBHOOK_SECRET` set, the route 404s — there's no way to
   authenticate a request, so it fails closed rather than accepting
   everything.

**Local dev:** Composio can't reach `localhost`. Use a tunnel (ngrok,
Cloudflare Tunnel, etc.) pointed at the webhook route, or skip the webhook
entirely and fire the automation by hand — ask the agent to run it, which
calls the `run_automation_now` tool — while developing.

**The connect-fast-path caveat.** The integrations POST endpoint's "connect"
action has a fast path: if you're already authorized with Composio for a
toolkit, it flips the toolkit on immediately without capturing a connected-
account id. Only the status-poll path (the one a fresh OAuth redirect lands
on) captures the connected-account id that webhook routing keys off of. So a
toolkit connected via the fast path — including any toolkit connected before
this release shipped — has no webhook route until it goes through one fresh
`authorize()` + poll cycle. Disconnect and reconnect the toolkit once if its
webhook triggers aren't firing.

## Saved vendos: no localStorage migration in v1

The client picks a saved-vendo store based on whether the server reports
durable storage (`GET <mount>/capabilities` → `storage: true`): with durable
storage, it talks to the server (`/vendos` endpoints); without it, it falls
back to `localStorage`, same as before this release.

There is no migration path from an existing `localStorage` library into the
server store in v1. Turning on durable storage for an app that already has
vendos saved in visitors' browsers means the server-side library starts
empty — those localStorage entries aren't lost, but they also aren't pulled
forward automatically. `localStorage` remains the fallback whenever
`storage` is off (or absent), so nothing regresses for installs that don't
turn on durable storage.
