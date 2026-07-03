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

The client reads `GET /api/flowlet/capabilities` and gates its UI on the
answer, so the integrations tray simply doesn't offer connections until the
Composio key exists.

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

## Deploying

Zero-config serves **local requests only** — the handler holds your keys and
its default policy auto-runs read tools, so a bare deployment answering
anonymous internet traffic would be wrong. Two ways to go live:

- **Recommended:** pass a `principal` resolver:
  `createFlowletHandler({ principal: async (req) => yourAuth(req) ?? null })` —
  your auth becomes the gate (return `null` to reject).
- **Escape hatch:** set `FLOWLET_ALLOW_REMOTE=1` if you understand the
  exposure (e.g. an internal preview).

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
