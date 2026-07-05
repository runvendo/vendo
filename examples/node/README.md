# examples/node — Flowlet without Next.js

Flowlet's handler core is fetch-native (`@flowlet/server`), so any Node server can host it.
This example runs it on plain `node:http` (`server.mjs`, ~30 lines of logic) with a Vite React
client reusing the exact `FlowletRoot` surface `flowlet init` wires into Next.js apps —
`@flowlet/next/client` is plain React and imports nothing from Next.js.

## Run

```bash
pnpm install && pnpm build                              # repo root, once
ANTHROPIC_API_KEY=sk-... pnpm --filter @flowlet/example-node dev
```

Any one provider key gives working chat + generated UI: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` (non-Anthropic providers need their
optional peer installed, e.g. `@ai-sdk/openai`). `FLOWLET_MODEL=provider/model` overrides.

- **API** — http://localhost:3300/api/flowlet (`node:http`, `PORT` overrides)
- **App** — http://localhost:3301 (Vite, proxies `/api/flowlet` to :3300)

`predev` copies the two sandbox runtime assets (react shim + components bundle) into
`public/flowlet/`, building the components bundle on first run. On a real install
`flowlet init` provisions these; they're ~4.7 MB of built output, so here they're
copied, not checked in. Both servers serve them: Vite from `public/` in dev,
`server.mjs` statically (the production story — Next.js did this implicitly).

No `.flowlet/` directory is needed — the handler falls back to the default brand and an
empty tool manifest (zero-config).

**Monorepo caveat:** the workspace packages' dists are built for bundlers (extensionless
ESM imports), so `dev:api` runs `server.mjs` through `tsx` — the same way apps/gmail runs
its Express server. The server code is plain `node:http`; plain `node server.mjs` works
once the packages publish Node-loadable ESM.

## Express

```js
import express from "express";
import { createFlowletFetchHandler, toNodeHandler } from "@flowlet/server";

const app = express();
app.all("/api/flowlet/*", toNodeHandler(createFlowletFetchHandler())); // Express 5: "/api/flowlet/{*path}"
app.use("/flowlet", express.static("public/flowlet")); // sandbox runtime assets
app.listen(3300);
```

## Hono / Bun

The fetch handler is `(Request) => Promise<Response>`, so fetch-native runtimes mount it
directly — no bridge:

```ts
import { Hono } from "hono";
import { createFlowletFetchHandler } from "@flowlet/server";

const flowlet = createFlowletFetchHandler();
const app = new Hono();
app.all("/api/flowlet/*", (c) => flowlet(c.req.raw));

export default app; // Bun.serve; on Node use @hono/node-server's serve(app)
```
