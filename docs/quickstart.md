# Flowlet Quickstart

Zero infra. Bring your own keys. One command.

Flowlet embeds an AI assistant in your Next.js app that chats, calls your own
API as the signed-in user, and renders generated UI in a sandboxed,
brand-native surface — all served from your app's own server. There is no
Flowlet cloud in this path: your model key talks straight to your chosen
provider (Anthropic, OpenAI, or Google), and everything else stays in your
process.

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
- drops `.env.example` documenting the capability-additive key ladder (see
  below);
- copies the sandbox runtime assets into `public/flowlet/`;
- adds `@flowlet/next` to your dependencies.

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

The client reads `GET /api/flowlet/capabilities` and gates its UI on the
answer, so the integrations tray simply doesn't offer connections until the
Composio key exists.

**Choosing a model.** With no key set, precedence is Anthropic > OpenAI >
Google, using per-provider defaults (`claude-sonnet-5`, `gpt-5.5`,
`gemini-3.5-flash`). Override with `FLOWLET_MODEL`, either form:

```bash
FLOWLET_MODEL=openai/gpt-5.5-mini   # provider/model: picks the provider outright
FLOWLET_MODEL=claude-sonnet-4-6     # bare id: applied to whichever provider key is set
```

`FLOWLET_MODEL` alone names a model, not a credential: without a real
provider key (or a code-injected `model`), chat stays off. OpenAI and Google
are optional peers (`@ai-sdk/openai`, `@ai-sdk/google`): resolving to one
without its package installed fails fast with an actionable `npm i` hint, not
a silent fallback.

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

## Not using Next.js?

Next.js is the first adapter, not a requirement. `@flowlet/next` is a thin
wrapper around `@flowlet/server`, the framework-agnostic handler core: a
plain `(Request) => Promise<Response>` function you can mount anywhere.

```bash
npm install @flowlet/server   # (from tarball/workspace until ENG-198, same as @flowlet/next)
```

```js
import { createServer } from "node:http";
import { createFlowletFetchHandler, toNodeHandler } from "@flowlet/server";

createServer(toNodeHandler(createFlowletFetchHandler())).listen(3000);
```

`createFlowletFetchHandler(options)` takes the same options as
`createFlowletHandler()` above. `toNodeHandler()` bridges the fetch handler
onto `node:http` (streaming-safe, so SSE chat works); Express mounting is one
line:

```js
app.all("/api/flowlet/*", toNodeHandler(createFlowletFetchHandler()));
```

Fetch-native runtimes skip the bridge entirely: Hono mounts the handler
directly.

```js
const flowlet = createFlowletFetchHandler();
app.all("/api/flowlet/*", (c) => flowlet(c.req.raw));
```

See `examples/node` for a full working server (plain `node:http` plus a Vite
client) including serving the sandbox runtime assets that Next.js handles
implicitly.

> **Status honesty:** `@flowlet/server` isn't published to npm yet either
> (ENG-198). And unlike a published package, the workspace's built output is
> bundler-format ESM, not directly Node-loadable: `examples/node` runs its
> server through `tsx` for that reason (same trick `apps/gmail` uses). Plain
> `node server.js` starts working once the packages publish.

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
- **Chat errors immediately** — check that one of `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` is set in `.env.local`
  and restart the dev server; `GET /api/flowlet/capabilities` tells you what
  the server sees. A `FLOWLET_MODEL` alone doesn't count: it isn't a key.
- **Integrations tray is empty** — expected without `COMPOSIO_API_KEY`.
