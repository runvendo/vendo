# Relay Express host

Relay is the permanent non-Next corpus host for Vendo. It proves that the
`@vendoai/vendo` server is a framework-agnostic fetch handler by mounting it on
Express, while a plain Vite React SPA consumes the same wire through
`<VendoRoot>` and the stock `VendoOverlay` chrome.

The host includes a deterministically seeded in-memory task API, committed
OpenAPI-derived tools, a deep-teal extracted theme, and real-HTTP e2e coverage
for status, chat/tool execution, destructive approval, generated views, and
`vendo doctor`.

## Run it

From this package directory:

```sh
export ANTHROPIC_API_KEY=your-key
pnpm build
pnpm start
```

Relay listens on `http://localhost:3210` by default. Set `PORT` to override it.
`pnpm dev` runs the TypeScript server directly but deliberately serves the
already-built Vite output, so run `pnpm build` once first.

The tests do not use an LLM key or external network:

```sh
pnpm test
```

## Adapter boundary

[`src/server/fetch-adapter.ts`](src/server/fetch-adapter.ts) is intentionally
host-owned integration code. It turns Node's `IncomingMessage` into a WHATWG
`Request`, calls Vendo's portable handler, and pipes the WHATWG `Response` body
back to Node with backpressure. The response is streamed rather than buffered,
which keeps `POST /api/vendo/threads` SSE incremental.
