# MCP client support — live verification (2026-07-04)

Spec: `docs/superpowers/specs/2026-07-04-flowlet-mcp-client-design.md`
Plan: `docs/superpowers/plans/2026-07-04-flowlet-mcp-client.md`

## 1. SDK handshake probe (pre-implementation)

Scratch probe against `@ai-sdk/mcp@1.0.6` with a minimal in-process
Streamable-HTTP server established the transport facts baked into the contract
test: notifications need `202` (a `200` without JSON/SSE content-type throws),
a startup GET (inbound SSE) gets a tolerated `405`, `initialize` must echo the
client's `protocolVersion`, `tools()` drops `annotations`, and the runtime
`listTools()` cast recovers them. PROBE PASSED.

## 2. Adapter smoke against a real MCP server

`createMcpToolSource()` against `@modelcontextprotocol/server-everything`
(Streamable HTTP, `http://localhost:3001/mcp`):

- 13 tools fetched (echo, get-sum, get-tiny-image, …), all with `execute`.
- `echo` round-trip returned `{"content":[{"type":"text","text":"Echo: flowlet-smoke"}],"isError":false}`.
- This server build reports no annotations → every tool correctly fail-safes
  to "needs approval". SMOKE PASSED.

## 3. Browser e2e in demo-bank (Maple)

`mcpServers: [{ name: "everything", url: "http://localhost:3001/mcp" }]` added
to the demo-bank handler (local-only edit, reverted), `pnpm demo` on :3457:

- `GET /api/flowlet/capabilities` → `{"chat":true,"integrations":true,"voice":true,"mcp":true}`.
- Prompt: *Use the everything_echo tool to echo the message "flowlet mcp e2e"…*
- The model called `everything_echo` (a `dynamic-tool` part); the policy
  paused it; the existing ApprovalCard rendered ("Needs your approval —
  Everything Echo", input shown) — `mcp-e2e-approval-card.png`.
- Clicking Approve resubmitted the turn, the tool executed on the real MCP
  server, and the model reported `Echo: flowlet mcp e2e` with the raw
  content/isError detail — `mcp-e2e-success.png`.

The first e2e attempt exposed (and this branch fixes) three `tool-*`-only
assumptions that silently dropped dynamic-tool parts: the shell thread
normalizer (no approval card), the react auto-resubmit predicate (approval
never resumed the turn), and the engine's stale-approval repair (a typed-past
MCP approval would wedge the thread).
