# Flowlet

Monorepo for Flowlet — a drop-in agentic experience — and the demo that showcases it.

## Layout

```
packages/
  flowlet-core    tools, UI nodes, GenUI format, generated components, stream protocol, agent, registry, stub agent
  flowlet-react   provider, useFlowletChat, in-memory transport, stub renderer
examples/
  basic           proves the stub loop end-to-end
apps/
  demo-bank       Maple — a demo consumer neobank, the host app for the "$87 Mystery" demo
docs/
  superpowers     design and plan docs (plans/, specs/)
```

The agent composes novel views with the `render_view` tool: a `components` map of generated React code bound to `$path` data, meshed with catalog and primitive components.

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
