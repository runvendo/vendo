# Flowlet

Monorepo for Flowlet. F1 (this milestone) ships the foundation contracts + stubs:

- `packages/flowlet-core` — tools, UI nodes, stream protocol, agent, registry, stub agent
- `packages/flowlet-react` — provider, `useFlowletChat`, in-memory transport, stub renderer
- `examples/basic` — proves the stub loop end-to-end

Design: `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`.
Reuse: `ai` SDK (protocol), MCP (tools + permission annotations), mcp-ui (sandbox — F3), Crayon (components — F4).

`pnpm install && pnpm build && pnpm test`
