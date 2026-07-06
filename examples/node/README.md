# examples/node — Vendo without Next.js

Vendo's handler core is fetch-native (`vendo/server`), so any Node server can host it.
This example runs it on plain `node:http` (`server.mjs`, ~30 lines of logic) with a Vite React
client reusing the exact `VendoRoot` surface `vendo init` wires into Next.js apps —
`vendo/react` is plain React and imports nothing from Next.js.

## Run

```bash
pnpm install && pnpm build                              # repo root, once
ANTHROPIC_API_KEY=sk-... pnpm --filter @vendoai/example-node dev
```

Any one provider key gives working chat + generated UI: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` (non-Anthropic providers need their
optional peer installed, e.g. `@ai-sdk/openai`). `VENDO_MODEL=provider/model` overrides.

- **API** — http://localhost:3300/api/vendo (`node:http`, `PORT` overrides)
- **App** — http://localhost:3301 (Vite, proxies `/api/vendo` to :3300)

`predev` copies the two sandbox runtime assets (react shim + components bundle) into
`public/vendo/`, building the components bundle on first run. On a real install
`vendo init` provisions these; they're ~4.7 MB of built output, so here they're
copied, not checked in. Both servers serve them: Vite from `public/` in dev,
`server.mjs` statically (the production story — Next.js did this implicitly).

No `.vendo/` directory is needed — the handler falls back to the default brand and an
empty tool manifest (zero-config).

**Monorepo caveat:** the workspace packages' dists are built for bundlers (extensionless
ESM imports), so `dev:api` runs `server.mjs` through `tsx`. The server code is plain
`node:http`; plain `node server.mjs` works
once the packages publish Node-loadable ESM.

## Express

```js
import express from "express";
import { createVendoFetchHandler, toNodeHandler } from "vendo/server";

const app = express();
app.all("/api/vendo/*", toNodeHandler(createVendoFetchHandler())); // Express 5: "/api/vendo/{*path}"
app.use("/vendo", express.static("public/vendo")); // sandbox runtime assets
app.listen(3300);
```

## Hono / Bun

The fetch handler is `(Request) => Promise<Response>`, so fetch-native runtimes mount it
directly — no bridge:

```ts
import { Hono } from "hono";
import { createVendoFetchHandler } from "vendo/server";

const vendo = createVendoFetchHandler();
const app = new Hono();
app.all("/api/vendo/*", (c) => vendo(c.req.raw));

export default app; // Bun.serve; on Node use @hono/node-server's serve(app)
```
