# @vendoai/dev-riders

Dev-mode model sessions for Vendo (ENG-338). When a developer has no model API
key but an authed CLI login, Vendo's dev mode can ride it as the model behind
the embedded agent:

- **Claude Code session** — via `@anthropic-ai/claude-agent-sdk`, resolved from
  the host app's own `node_modules` (never bundled here; `vendo init` offers the
  install with consent).
- **Codex session** — via `codex app-server` (JSON-RPC over stdio, no
  dependencies).

Both riders own only the model loop. Every tool call is handed back to the
Vendo runtime, which executes it through the same guard-bound path as any other
turn — approvals, grants, and audit are unchanged.

Development only. The Vendo runtime refuses these sessions when
`NODE_ENV === "production"`; production deploys always require a real
server-side key.

Part of [Vendo](https://vendo.run). Install `vendoai` instead of this package
directly — see the [quickstart](https://github.com/runvendo/vendo/blob/main/docs/quickstart.md).
