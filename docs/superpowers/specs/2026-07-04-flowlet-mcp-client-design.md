# Flowlet MCP Client Support — Design

**Date:** 2026-07-04
**Status:** Approved by Yousef (brainstorm 2026-07-04)
**Context:** OSS-release feature audit flagged MCP client support as the top table-stakes gap. The F2 agent-core design (2026-06-30) already reserved the seam: a 4th tool source `"mcp"` via `@ai-sdk/mcp`, precedence `caller > engine > composio > mcp`. This design fills that seam; it introduces no new architecture.

## Goal

A host can declare remote MCP servers and their tools become agent tools, governed by the existing policy/approval engine exactly like every other tool source. No parallel path.

## Scope rulings (Yousef, 2026-07-04)

| Question | Ruling |
|---|---|
| Who adds servers | **Host-configured only.** User-added servers deferred. |
| Transports | **Streamable HTTP only** (with SDK SSE fallback). stdio deferred. |
| Ingestion strictness | **All tools from a declared server by default; optional per-server `tools` allowlist** narrows. Declaring the URL is the explicit grant. |
| Auth | **Static headers per server** (host references its own env). OAuth-only servers deferred. |
| Annotation trust | **Trust server-sent hints, same as Composio.** `readOnlyHint` auto-allows via the existing annotation policy; destructive/unknown requires approval. |
| Config surface | **Code option + `.flowlet/mcp.json`.** Code overrides file. |
| UI | **None in v1.** IntegrationsPicker stays Composio-only. |
| MCP capabilities | **Tools only.** Resources, prompts, elicitation, sampling, MCP Apps deferred. |

## Approach

Mirror the Composio adapter (`packages/flowlet-runtime/src/composio.ts`) structurally. Rejected alternatives: a generalized `ToolSourceProvider` plugin abstraction (YAGNI at n=2, and the sources genuinely differ — per-user OAuth vs shared host connection); doing it in `@flowlet/next` via the caller `tools` option (wrong layer: loses provenance, annotations, and non-Next consumers).

Reuse the AI SDK MCP client (`createMCPClient` from `@ai-sdk/mcp@1.0.6`, already a runtime dependency and already on the dependency-guard allowlist). No hand-rolled protocol code.

## 1. Runtime ingestion — `packages/flowlet-runtime/src/mcp.ts`

**Config shape** (per server): `name` (required; becomes the tool-name prefix and must be a valid tool-name fragment), `url` (required; http/https), `headers` (optional map, e.g. Authorization), `tools` (optional narrowing allowlist of unprefixed tool names).

**Seam:** an injectable `McpToolSource` interface (the `ComposioClient` analogue) with a single `fetchTools(config) → ToolSet` responsibility. The real implementation wraps `createMCPClient` with the HTTP transport plus `client.tools()`; tests inject a fake. Construction is lazy — nothing touches the network until first fetch.

**`ingestMcpTools`** fails closed: an empty/absent server list returns empty without any network call. Per-server fault tolerance mirrors Composio's per-toolkit pattern: an unreachable or misbehaving server logs a warning and contributes nothing; it never breaks other servers or the turn.

**Tool naming:** ingested tools are registered as `<serverName>_<toolName>`. Prevents cross-server collisions and collisions with other sources; makes provenance legible in approval cards. The optional `tools` allowlist matches the unprefixed name.

**Descriptors:** each tool gets `buildDescriptor(prefixedName, tool, "mcp")`. The existing extraction (`_meta.annotations` / top-level `annotations`) already handles `@ai-sdk/mcp` output, so MCP `readOnlyHint`/`destructiveHint`/etc. land in the descriptor and flow through the unchanged `annotationPolicy`.

**Lifecycle & caching:** MCP tools are host-level, not per-user. The engine memoizes one ingestion per server-config set — first turn pays the `tools/list` round-trip, subsequent turns resolve instantly. Failures are never cached (next turn retries). Underlying MCP clients are kept open and reused; a dead connection is rebuilt on next use rather than failing the turn permanently.

## 2. Engine wiring — `packages/flowlet-runtime/src/engine.ts`

New optional agent-config field `mcp: { servers: McpServerConfig[] }`. Ingestion runs beside the Composio block; the sources array becomes `caller, engine, composio, mcp` (F2 precedence — on a name collision MCP loses, and the existing `onCollision` warning fires).

Every MCP tool passes through `wrapTool` via `buildToolset`: the SDK client supplies `execute`, so the fail-closed no-execute check passes, and each call gets the standard `needsApproval` preflight plus the authoritative re-evaluating `execute` gate. Zero changes to the policy directory.

## 3. `@flowlet/next` surface

- `createFlowletHandler({ mcpServers: [...] })`, zod-validated (strict schema, readable boot error).
- `.flowlet/mcp.json` holding the same array, loaded via the existing flowlet-dir machinery. The code option **overrides** the file entirely (same relationship as `hostTools` vs `tools.json`).
- Header values in `mcp.json` support `${ENV_VAR}` substitution so tokens never live in a checked-in file. A missing referenced env var drops that server with a boot-time warning (fail closed, don't send empty auth).
- **Capability-additive:** `capabilities.mcp` is `true` iff ≥1 server is declared after resolution. No servers → surface inert, no errors — same contract as a missing `COMPOSIO_API_KEY`.
- No UI. No IntegrationsPicker changes.

## 4. Explicitly deferred

stdio transport; OAuth server auth; user-added servers (per-user storage, SSRF guarding, connect UI); MCP resources/prompts/elicitation/sampling/MCP Apps; IntegrationsPicker visibility for declared servers; a per-server `trustAnnotations` override (v1 trusts hints globally per the ruling above).

## 5. Error handling summary

- No servers declared → empty ingestion, zero network, capability off.
- Server unreachable / handshake fails → warn, skip that server, keep the rest. For a server that was sent ANY headers the remote error message is withheld from logs entirely (a malicious server can reflect tokens transformed — base64/split — so substring redaction is not enough); headerless servers log the truncated message. The partial result is served from cache but scheduled for eviction after `retryDelayMs` (default 30s, engine-configurable), so failed servers are retried without a permanently-down one adding a connect timeout to every turn.
- Env substitution target missing → warn at boot, drop that server. Same for any header value still containing `${...}` after substitution (lowercase/dashed/typo'd refs) — never send a literal template to a server.
- Duplicate server names → warn, skip the later one (also rejected by zod at the config surface).
- Prefix-ambiguous server names (`a` and `a_b`) → rejected by zod at the config surface.
- Server-returned tool name not provider-safe after prefixing (must match `[A-Za-z0-9_-]{1,64}`) → warn, skip that tool fail-closed (a bad name would 400 the whole turn at the model API).
- Final-name collision inside MCP (server `a` tool `b_c` vs server `a_b` tool `c`) → warn and drop ALL claimants of that name. First-wins would let a malicious earlier server squat a trusted server's canonical tool name; dropping both turns impersonation into (warned) denial.
- Cross-source tool-name collision → existing `onCollision` warning, higher-precedence source wins.
- Tool without `execute` (shouldn't happen via SDK) → existing `onSkip` fail-closed exclusion.
- Mid-turn call failure → normal ai-SDK tool error surface, same as any tool.
- Client-side, MCP tools stream as ai-SDK `dynamic-tool` parts: the shell thread renderer, the react auto-resubmit predicate, and the engine's stale-approval repair all handle them like static tool parts, while host-tool execution predicates deliberately ignore dynamic parts (host tools are always static — a dynamic tool spoofing a host tool name must never reach the browser executor).

**SSRF posture:** server URLs come only from host code or the host's repo (`.flowlet/mcp.json`) — never from request input. The URL validation is deliberately not an SSRF guard (localhost/private ranges are legitimate for host-declared servers); user-added servers (deferred) must add network denylisting first.

## 6. Testing

- **Unit (TDD, fake `McpToolSource`):** fail-closed empty config; prefixing; allowlist narrowing; per-server fault tolerance; descriptor source/annotation capture; engine precedence with all four sources.
- **Contract:** real `@ai-sdk/mcp@1.0.6` output shape — annotations land in descriptors (extends the existing descriptor contract tests).
- **Handler:** option validation, mcp.json loading + override, `${ENV_VAR}` substitution incl. missing-var drop, capability flag.
- **Live smoke (verification):** one real HTTP MCP server end-to-end — tool listed, policy-gated, callable.
