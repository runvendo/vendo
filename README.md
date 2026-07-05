# Vendo

Monorepo for Vendo — a drop-in agentic experience — and the demo that showcases it.

## Telemetry

Vendo collects anonymous, opt-out usage telemetry from build and development tooling. See [TELEMETRY.md](./TELEMETRY.md).

## Layout

```
packages/
  vendo-core    tools, UI nodes, GenUI format, generated components, stream protocol, agent, registry, stub agent
  vendo-react   provider, useVendoChat, in-memory transport, stub renderer
examples/
  basic           proves the stub loop end-to-end
apps/
  demo-bank       Maple — a demo consumer neobank, the host app for the "$87 Mystery" demo
docs/
  superpowers     design and plan docs (plans/, specs/)
```

There is one UI tool, `render_view`, and its output always renders in the egress-jailed sandbox. The agent composes each view as a flat tree of nodes: prewired primitives, host catalog components, and novel generated React code bound to `$path` data. Even a single component is a one-node generated view. The only host-rendered exception is the Connect OAuth card (via `request_connect`), which needs host privileges.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
```

Run the demo bank:

```bash
pnpm --filter demo-bank dev
```

Open http://localhost:3000.

## More

- `apps/demo-bank/README.md` — the Maple app: stack, architecture, API endpoints, and the planted demo charge.
- `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md` — F1 foundation design.
- Reuse: `ai` SDK (protocol), MCP (tools + permission annotations), mcp-ui (sandbox — F3), Crayon (components — F4).
