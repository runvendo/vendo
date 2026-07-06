# Vendo Quickstart

Zero infra. Bring your own keys. One command.

Vendo embeds an AI assistant in your Next.js app that chats, calls your own
API as the signed-in user, and renders generated UI in a sandboxed,
brand-native surface — all served from your app's own server. There is no
Vendo cloud in this path: your model key talks straight to your chosen
provider (Anthropic, OpenAI, or Google), and everything else stays in your
process.

## Install (Next.js App Router)

```bash
npx create-next-app@latest my-app     # or your existing app
cd my-app
npm install vendo
npx vendo init .
```

`vendo init` is a codemod, not a scaffold. On a Next.js App Router app it:

- extracts your **theme, tools, and components** into `.vendo/` (the
  reviewable source of truth — edit these files);
- writes `app/api/vendo/[...path]/route.ts` containing
  `createVendoHandler()` — one catch-all serving `chat`, `action`,
  `integrations`, `capabilities`, `tick`, `webhooks/composio`, `threads` /
  `threads/<id>`, `events/ingest`, and `vendos` / `vendos/<id>` /
  `vendos/<id>/delete`;
- writes `app/vendo-root.tsx` (a small client wrapper) and wraps your root
  layout's `{children}` with it — idempotently, respecting existing providers;
- writes `instrumentation.ts` (or `src/instrumentation.ts`, next to a
  `src/app`) that boots the automation scheduler on server start;
- drops `.env.example` documenting the capability-additive key ladder (see
  below) plus the storage and scheduler env vars (see
  [Persistence](#persistence));
- copies the sandbox runtime assets into `public/vendo/`;
- adds `vendo` to your dependencies.

It never breaks existing code: any step it can't perform with certainty (an
unusual layout, an unparsable package.json) is skipped and printed as an exact
manual instruction instead. Review the whole install in one `git diff`.

## One key = working product

```bash
cp .env.example .env.local
# paste your ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY: any one works)
npm run dev
```

Open the app, hit the launcher pill (or **Cmd/Ctrl+K**), and ask for
something visual — "show me a dashboard comparing three savings plans." The
assistant chats and renders a live generated view (charts, tables, stat
cards) inside an egress-jailed sandbox iframe. That's the whole install: we
time this at well under ten minutes of dev effort on a fresh app.

## The capability ladder

Keys are additive. Each one you add lights up a capability; a missing key
hides that surface — nothing errors.

| Key(s) | Unlocks |
| --- | --- |
| Any one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | Chat + generated UI (the one-key minimum) |
| `OPENAI_API_KEY` specifically | Also flips on the voice capability flag (a flag only: voice UX is in design) |
| `+ COMPOSIO_API_KEY` | Integrations: Gmail, Slack, Notion, … via OAuth connect cards |
| `+ MCP servers declared` | Any remote MCP server's tools, policy-governed (config, not a key — see below) |

The client reads `GET /api/vendo/capabilities` and gates its UI on the
answer, so the integrations tray simply doesn't offer connections until the
Composio key exists.

**Choosing a model.** Absent a `VENDO_MODEL` override, Vendo picks a
provider from whichever keys are set (precedence Anthropic > OpenAI > Google)
and uses its default model (`claude-sonnet-5`, `gpt-5.5`, `gemini-3.5-flash`
respectively). Override with `VENDO_MODEL`, either form:

```bash
VENDO_MODEL=openai/gpt-5.5-mini   # provider/model: picks the provider outright
VENDO_MODEL=claude-sonnet-4-6     # bare id: applied to whichever provider key is set
```

`VENDO_MODEL` alone names a model, not a credential: without a real
provider key (or a code-injected `model`), chat stays off. OpenAI and Google
are optional peers (`@ai-sdk/openai`, `@ai-sdk/google`): resolving to one
without its package installed fails fast with an actionable `npm i` hint, not
a silent fallback.

## MCP servers

Point Vendo at any remote MCP server and its tools become agent tools,
governed by the same approval policy as everything else.

Either declare them in code:

```ts
export const { GET, POST } = createVendoHandler({
  mcpServers: [
    {
      name: "weather",                    // tools appear as weather_<tool>
      url: "https://mcp.example.com/mcp", // Streamable HTTP endpoint
      headers: { Authorization: `Bearer ${process.env.WEATHER_TOKEN}` }, // optional
      tools: ["get_forecast"],            // optional allowlist; omit = all tools
    },
  ],
});
```

or in `.vendo/mcp.json` (the code option wins entirely if both exist):

```json
{
  "version": 1,
  "servers": [
    {
      "name": "weather",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WEATHER_TOKEN}" }
    }
  ]
}
```

In `mcp.json`, `${VAR}` in header values is read from the environment at
boot; a server whose variable is unset is skipped with a warning. Notes:
HTTP transport only (no stdio), static headers only (OAuth-only servers not
yet supported), tools only (no resources/prompts). Server-reported
annotations are honored: read-only tools run freely, everything else pauses
for approval.

## Your API as the agent's hands

`.vendo/tools.json` is your API surface as tool descriptors (extracted from
your OpenAPI spec when you have one, or an LLM route-scan when you don't).
Two properties matter:

- Tools execute **in the user's browser on their existing session** — the
  agent acts as the signed-in user through your own auth; calls never transit
  anywhere else.
- The extractor is **fail-closed**: route-scanned tools are all marked
  `mutating: true`, which means the policy pauses them for user approval.
  Relaxing an annotation to `mutating: false` (auto-run reads, saved-view
  refresh) is a reviewed edit you make by hand.

## Events

Host events are declared in `.vendo/tools.json` next to tools. Once declared,
the automation authoring agent can compile `host_event` triggers from chat.

```json
{
  "version": 1,
  "tools": [],
  "events": [
    { "name": "transaction.created", "description": "A card transaction was created." }
  ]
}
```

Produce event instances at the source whenever you can:

```ts
import { ingestVendoEvent } from "vendo/server";

await ingestVendoEvent("transaction.created", txn, {
  eventId: txn.id,
});
```

Relay third-party webhooks into your declared event names:

```ts
import { ingestVendoEvent } from "vendo/server";

const body = await req.json();
await ingestVendoEvent("transaction.created", body.data, {
  eventId: req.headers.get("webhook-id") ?? body.data.id,
});
```

For sources without push, run a 15-minute poller and use the source object's
id as the dedupe key:

```ts
for (const txn of await bank.listTransactions({ since: cursor })) {
  await ingestVendoEvent("transaction.created", txn, {
    eventId: txn.id,
  });
}
```

Out-of-process producers can call `POST /api/vendo/events/ingest` with
`{ "name", "payload", "eventId" }`; `eventId` is required and must be a stable
producer delivery id. It uses the same local/principal guard as
other mutating routes, and also accepts
`Authorization: Bearer $VENDO_TICK_SECRET` when that secret is configured.
`ingestVendoEvent()` accepts an omitted `eventId` for in-process fire-and-forget
producers, but omitting it disables redelivery dedup across restarts. If you use
`bootKey`, pass the same key to `createVendoHandler()` or `startVendoScheduler()`
and to your producer.

## Customizing

`createVendoHandler()` is zero-config by default and takes validated
options when you outgrow that: `model`, `instructions`/`instructionsExtra`,
`policy`, server-side `tools`, host `components`, an `integrations` catalog,
`connections` (bring your own store), `cacheKey`, `automations`, `storage`
(durable engine store — PGlite by default, `DATABASE_URL`, or `false` for
in-memory). Our own demo-bank app runs entirely on this handler, with its
custom policy, prompt, and demo world injected through those options.

Prompts are assembled from a shared core in `@vendoai/core` (`buildChatInstructions`
/ `buildVoiceInstructions`): the platform owns the behavioral rules (when to
render vs. talk, register, consent, capability talk, closing guardrails) and
your app supplies identity, brand, catalogs, and free-form `extras` on both
the chat and voice sides — host extras always land *before* the guardrails, so
platform safety rules win on conflict. `instructions` also accepts a function
`(ctx) => string` evaluated per run with `ctx.toolSummary` (the live merged
toolset), which is how the default prompt grounds "what can you do?" answers
in what is actually connected. Oversized tool results are capped
deterministically at every ingestion point (`capToolOutput`) — HTML becomes
text, binary is dropped, long arrays are truncated with an honest note —
before they reach the model.

## Not using Next.js?

Next.js is the first adapter, not a requirement. The core is framework-agnostic:
`createVendoHandler()` (above) is just a `{ GET, POST }` pair of plain
`(Request) => Promise<Response>` functions — that's why a Next.js App Router
catch-all can export it directly. Everywhere else, `vendo/server` exposes the
same core as `createVendoFetchHandler()`, a single fetch handler you mount on
any runtime. No extra install — it's the same `vendo` dependency.

```js
import { createServer } from "node:http";
import { createVendoFetchHandler, toNodeHandler } from "vendo/server";

createServer(toNodeHandler(createVendoFetchHandler())).listen(3000);
```

`createVendoFetchHandler(options)` takes the same options as
`createVendoHandler()` above. `toNodeHandler()` bridges the fetch handler
onto `node:http` (streaming-safe, so SSE chat works); Express mounting is one
line:

```js
app.all("/api/vendo/*", toNodeHandler(createVendoFetchHandler()));
```

Fetch-native runtimes skip the bridge entirely: Hono mounts the handler
directly.

```js
import { createVendoFetchHandler } from "vendo/server";

const vendo = createVendoFetchHandler();
app.all("/api/vendo/*", (c) => vendo(c.req.raw));
```

See `examples/node` for a full working server (plain `node:http` plus a Vite
client) including serving the sandbox runtime assets that Next.js handles
implicitly.

## Persistence

Storage is durable by default: with no `storage` option, `createVendoHandler`
opens an embedded PGlite database at `.vendo/data` and persists automations
(with their versions, grants, and run history), approval decisions, chat
threads, and saved vendos — all of it survives a server restart. Point
`DATABASE_URL` at a hosted Postgres (Supabase, Neon, RDS) to move off PGlite,
or pass `storage: false` to opt back into in-memory. The scheduler that fires
schedules without a browser open boots from the `instrumentation.ts` the
codemod wrote for you; the same handler also has a signature-verified
Composio webhook route (`POST /api/vendo/webhooks/composio`) so triggers
fire without polling. Full detail — scheduler modes for serverless deploys,
the webhook setup, and the single-writer/single-tenant posture you should
know before deploying — lives in
[`docs/persistence-and-deploy.md`](persistence-and-deploy.md).

## Deploying

Zero-config serves **local requests only** — the handler holds your keys and
its default policy auto-runs read tools, so a bare deployment answering
anonymous internet traffic would be wrong. Going live safely:

- **Recommended — gate with a `principal` resolver:**
  `createVendoHandler({ principal: async (req) => yourAuth(req) ?? null })`.
  Your app's auth becomes the gate (return `null` → 403). **Do this for
  anything internet-reachable.** The built-in local-only fallback keys off the
  `Host` header, which a client can spoof and a reverse proxy can rewrite — it
  is a dev convenience, not a production control. A real `principal` resolver
  replaces it entirely.
- **Escape hatch:** `VENDO_ALLOW_REMOTE=1` disables the local guard with no
  replacement — use only for a throwaway internal preview you trust.

**Single-tenant, single-process by default.** The automations world's engine
store is durable by default (PGlite under `.vendo/data`, or a Postgres
`DATABASE_URL`) — pass `storage: false` to opt back into in-memory. The
built-in connections store and approval-token store are still in-memory. None
of them are keyed by user, so:

- Run the handler as **one long-lived Node process**, not on a serverless
  platform that spreads requests across cold instances — otherwise an approval
  token issued on one instance won't be found on another (the sandbox will loop
  on "approval expired") and connection state won't be shared.
- Treat it as **one tenant**. A `principal` resolver is an access *gate*, not
  tenant *isolation*: connected toolkits and cached agents are process-global,
  so don't rely on it to separate two users' integrations. Multi-tenant
  installs must inject their own per-user `connections` store (and will want
  host-provided approval/automation stores).

See [`docs/persistence-and-deploy.md`](persistence-and-deploy.md) for the
scheduler and Composio webhook setup you'll want on a real deployment.

## Troubleshooting

- **"Sandbox unavailable / react shim missing"** — `public/vendo/` is
  missing its two assets; re-run `npx vendo init . --force` or copy them
  from the CLI's `dist/assets/`.
- **Chat answers 403 on a deployment** — that's the local-only default; see
  Deploying above.
- **Chat errors immediately** — check that one of `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` is set in `.env.local`
  and restart the dev server; `GET /api/vendo/capabilities` tells you what
  the server sees. A `VENDO_MODEL` alone doesn't count: it isn't a key.
- **Integrations tray is empty** — expected without `COMPOSIO_API_KEY`.
