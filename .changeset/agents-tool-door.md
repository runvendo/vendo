---
"@vendoai/agents": minor
"@vendoai/mcp": minor
"@vendoai/vendo": patch
---

`agent()` mounts the tool door its harness has always required.

`claudeCode()` declares `requires: { toolDoor: true }` on both legs — a box and
a local subprocess each reach the host's tools over remote MCP — and
`@vendoai/agents` never filled the slot. A boxed agent therefore booted with the
model's own hands (Bash, Read, Write) and NONE of the host's tools: no `api()`,
no `tool({ … })`, no `mcp:` servers. It was silent, because the harness's warning
is itself gated on a door existing.

`agent()` gains one optional key, **`door: { baseUrl }`** — the publicly
reachable origin the thinker dials back to. Unset it falls back to
`VENDO_BASE_URL`; an explicit value always wins. A `machine: "local"` thinker
that resolves neither gets a loopback listener this package serves itself — a
subprocess can always dial 127.0.0.1, so zero-config development loses
nothing. A SANDBOXED harness that resolves neither is a BOOT error naming both
ways out, never a turn that dies in front of a user: loopback is not reachable
from a box.

A library cannot add a route to the host's server, so the door's fetch handler
comes back out: mount `agent.door` at the exported `DOOR_PATH`
(`/api/vendo/mcp`, the same mount `createVendo` uses). It is
`createMcpDoor({ internal: true })` — no authorization server, no discovery, no
consent page, and no listing for anyone but a live turn. The door's hostname
joins the box's egress allowlist, and the runtime's `liveTurn` seam is wired, so
a credential the harness mints resolves to the turn that minted it and to
nothing between turns.

`@vendoai/agents` now depends on `@vendoai/mcp`, which widens a standalone
install with `@modelcontextprotocol/sdk` and `jose`.

`createTurnCredentials` — the turn-credential registry — moves from
`@vendoai/vendo` down into `@vendoai/mcp`, beside the `LiveTurn` /
`TurnCredentialPort` types it speaks, so the umbrella and the standalone runtime
share ONE implementation instead of each growing their own. No behaviour change
for `createVendo`.
