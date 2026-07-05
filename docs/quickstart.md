# Flowlet Quickstart

Zero infra. Bring your own keys. One command.

Flowlet embeds an AI assistant in your Next.js app that chats, calls your own
API as the signed-in user, and renders generated UI in a sandboxed,
brand-native surface — all served from your app's own server. There is no
Flowlet cloud in this path: your Anthropic key talks to Anthropic, and
everything else stays in your process.

> **Status honesty:** the `@flowlet/*` packages are not published to npm yet
> (publishing lands with the registry work, ENG-198). Today you install them
> from packed tarballs or the monorepo workspace. Everything below is the
> exact flow we verify end-to-end on a fresh `create-next-app` — including the
> tarball install — it just isn't `npm i @flowlet/next` from the public
> registry yet.

## Install (Next.js App Router)

```bash
npx create-next-app@latest my-app     # or your existing app
cd my-app
npm install @flowlet/next             # (from tarball/workspace until ENG-198)
npm install -D @flowlet/cli
npx flowlet init .
```

`flowlet init` is a codemod, not a scaffold. On a Next.js App Router app it:

- extracts your **theme, tools, and components** into `.flowlet/` (the
  reviewable source of truth — edit these files);
- writes `app/api/flowlet/[...path]/route.ts` containing
  `createFlowletHandler()` — one catch-all that serves chat, sandbox actions,
  integrations, capabilities, and the automations tick;
- writes `app/flowlet-root.tsx` (a small client wrapper) and wraps your root
  layout's `{children}` with it — idempotently, respecting existing providers;
- drops `.env.example` documenting the three keys;
- copies the sandbox runtime assets into `public/flowlet/`;
- adds `@flowlet/next` to your dependencies.

It never breaks existing code: any step it can't perform with certainty (an
unusual layout, an unparsable package.json) is skipped and printed as an exact
manual instruction instead. Review the whole install in one `git diff`.

## One key = working product

```bash
cp .env.example .env.local
# paste your ANTHROPIC_API_KEY
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

| Key | Unlocks |
| --- | --- |
| `ANTHROPIC_API_KEY` | Chat + generated UI (the one-key minimum) |
| `+ COMPOSIO_API_KEY` | Integrations: Gmail, Slack, Notion, … via OAuth connect cards |
| `+ OPENAI_API_KEY` | Reserved for voice — exposed as a capability flag only (voice UX is in design) |
| `+ MCP servers declared` | Any remote MCP server's tools, policy-governed (config, not a key — see below) |

The client reads `GET /api/flowlet/capabilities` and gates its UI on the
answer, so the integrations tray simply doesn't offer connections until the
Composio key exists.

## MCP servers

Point Flowlet at any remote MCP server and its tools become agent tools,
governed by the same approval policy as everything else.

Either declare them in code:

```ts
export const { GET, POST } = createFlowletHandler({
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

or in `.flowlet/mcp.json` (the code option wins entirely if both exist):

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

`.flowlet/tools.json` is your API surface as tool descriptors (extracted from
your OpenAPI spec when you have one, or an LLM route-scan when you don't).
Two properties matter:

- Tools execute **in the user's browser on their existing session** — the
  agent acts as the signed-in user through your own auth; calls never transit
  anywhere else.
- The extractor is **fail-closed**: route-scanned tools are all marked
  `mutating: true`, which means the policy pauses them for user approval.
  Relaxing an annotation to `mutating: false` (auto-run reads, saved-view
  refresh) is a reviewed edit you make by hand.

## Customizing

`createFlowletHandler()` is zero-config by default and takes validated
options when you outgrow that: `model`, `instructions`/`instructionsExtra`,
`policy`, server-side `tools`, host `components`, an `integrations` catalog,
`connections` (bring your own store), `cacheKey`, `automations`. Our own
demo-bank app runs entirely on this handler, with its custom policy, prompt,
and demo world injected through those options.

Prompts are assembled from a shared core in `@flowlet/core` (`buildChatInstructions`
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

## Deploying

Zero-config serves **local requests only** — the handler holds your keys and
its default policy auto-runs read tools, so a bare deployment answering
anonymous internet traffic would be wrong. Going live safely:

- **Recommended — gate with a `principal` resolver:**
  `createFlowletHandler({ principal: async (req) => yourAuth(req) ?? null })`.
  Your app's auth becomes the gate (return `null` → 403). **Do this for
  anything internet-reachable.** The built-in local-only fallback keys off the
  `Host` header, which a client can spoof and a reverse proxy can rewrite — it
  is a dev convenience, not a production control. A real `principal` resolver
  replaces it entirely.
- **Escape hatch:** `FLOWLET_ALLOW_REMOTE=1` disables the local guard with no
  replacement — use only for a throwaway internal preview you trust.

**Single-tenant, single-process by default.** The built-in connections store,
approval-token store, and automations world are in-memory and **not** keyed by
user, so:

- Run the handler as **one long-lived Node process**, not on a serverless
  platform that spreads requests across cold instances — otherwise an approval
  token issued on one instance won't be found on another (the sandbox will loop
  on "approval expired") and connection state won't be shared.
- Treat it as **one tenant**. A `principal` resolver is an access *gate*, not
  tenant *isolation*: connected toolkits and cached agents are process-global,
  so don't rely on it to separate two users' integrations. Multi-tenant
  installs must inject their own per-user `connections` store (and will want
  host-provided approval/automation stores).

## Troubleshooting

- **"Sandbox unavailable / react shim missing"** — `public/flowlet/` is
  missing its two assets; re-run `npx flowlet init . --force` or copy them
  from the CLI's `dist/assets/`.
- **Chat answers 403 on a deployment** — that's the local-only default; see
  Deploying above.
- **Chat errors immediately** — check `ANTHROPIC_API_KEY` in `.env.local`
  and restart the dev server; `GET /api/flowlet/capabilities` tells you what
  the server sees.
- **Integrations tray is empty** — expected without `COMPOSIO_API_KEY`.
