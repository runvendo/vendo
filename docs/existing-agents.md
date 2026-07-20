# Use Vendo with your existing agent

Mirrors the docs-site group "Use with your existing agent"
(`docs-site/existing-agents/`). Update both when the seam changes.

You already have an agent (AI SDK, Mastra) with its own loop, model, and
chat UI. Vendo does not replace any of that. One tool pack, spread into your
agent's tools, adds:

1. **Guarded tools**: your host actions, each call routed through policy,
   approval, and audit. The pack wraps `vendo.guardedTools`, the same
   guard-bound registry Vendo's own loop uses; no tool reachable from your
   loop has an unguarded route.
2. **Generated UI in your chat**: `vendo_create_app` builds live apps that
   render inline in your own chat via embed components.
3. **Vendo as a delegate**: `vendo_delegate` hands Vendo's agent a whole
   task and returns `{ status, summary, refs }`.

## Composition

Run `createVendo` and mount the wire route exactly as the quickstart
describes; drop Vendo's chat loop and chat UI. The wire keeps serving apps
and approvals to the embeds: Vendo minus the conversation.

Two models, deliberately: your agent keeps its own model; Vendo's `model`
seam powers app generation and the delegate, resolving independently
(explicit `model`, env keys, or `VENDO_API_KEY` managed inference).

## Server seam

Two umbrella subpaths, both thin shims over one framework-neutral tool pack
core in `@vendoai/agent`:

- `@vendoai/vendo/ai-sdk`:
  `vendoTools(vendo, { principal, sessionId?, include?, exclude? }): Promise<ToolSet>`.
  Built per request; execution needs a principal-scoped context.
- `@vendoai/vendo/mastra`:
  `vendoMastraTools(vendo, { include?, exclude? }?): Promise<Record<string, MastraTool>>`.
  Mastra agent definitions are static, so the shim takes no principal; each
  call resolves it from Mastra's request context key `vendo-principal`
  (`VENDO_PRINCIPAL_KEY`, required, fails closed) and optional
  `vendo-session-id` (`VENDO_SESSION_KEY`). Returns a Promise, so use
  Mastra's tools-as-function form or top-level await. `@mastra/core` is an
  optional peer dep used only by this subpath.

Every pack tool is namespaced `vendo_*` (host action `host_x` ships as
`vendo_host_x`). `include`/`exclude` match final names exactly; `exclude`
wins. Built-ins: `vendo_create_app` (returns fast with an app ref; the build
streams over the wire) and `vendo_delegate` (via `agent.asRunner()`).

## Envelope contract

A `vendo_*` tool returns plain data (the call executed cleanly) or one
versioned envelope (`packages/core/src/tool-envelopes.ts`):

- `vendo/app-ref@1` `{ appId, title }` → `<VendoAppEmbed>`
- `vendo/approval-ref@1` `{ approvalId, summary }` → `<VendoApprovalEmbed>`

`parseVendoToolEnvelope(output)` in `@vendoai/core` is the shared
dispatcher; it returns `null` for plain data.

## Approvals in a foreign loop

A guarded call needing approval does not throw and does not block the loop:
the tool returns the approval-ref envelope immediately and the exact call
parks server-side. On approve (wire `POST /approvals/decide`, or the embed),
the wire executes the parked call once and persists the outcome;
`GET /approvals/:id` serves the resolution
(`pending | executed | declined | expired`). Deny discards the parked call.
Orphaned parked calls expire on a TTL sweep:
`createVendo({ approvals: { parkedCallTtlMs } })`, default 60 min, `0`
disables. Vendo-thread approvals are untouched.

## Client embeds

Three components in `@vendoai/ui`, rendered inside the host's
`VendoProvider` pointed at the wire (auth rides the host session cookie,
theme rides `--vendo-*` tokens, no config props):

- `<VendoToolResult output>`: dispatcher; renders the right embed or
  nothing for plain data.
- `<VendoAppEmbed refValue>`: build beat while the build streams, then the
  live app; in-app interactions go over the wire, not the host loop.
- `<VendoApprovalEmbed refValue>`: approve/deny; resolves in place to the
  executed result, "declined", or "expired". Failure states use the existing
  failed/expired vocabulary.

## Examples

Both under `examples/`, each the framework's canonical starter plus a
four-touch diff fenced with `--- vendo` markers: the composition file, the
stock wire route, the tools spread, and `VendoProvider` +
`<VendoToolResult>` in the chat page.

- `examples/ai-sdk-agent`: AI SDK Next.js quickstart chatbot;
  `...(await vendoTools(vendo, { principal }))` in `/api/chat`.
- `examples/mastra-agent`: create-mastra weather starter with a Next front
  (`@mastra/ai-sdk`);
  `tools: async () => ({ weatherTool, ...(await vendoMastraTools(vendo)) })`,
  principal set server-side on `RequestContext`. Pins `openai/gpt-4.1-mini`
  (upstream mastra#9005).

Demo script (both): weather question (guarded read, plain data) → "make me a
dashboard comparing weather in 3 cities" (app builds inline) → "email the
report" (approval card; approve executes the parked call in place).

Each ships a hermetic fixture e2e (`examples/*/e2e/`), scripted models, no
keys.

## Related

- Docs pages: `docs-site/existing-agents/{index,ai-sdk,mastra}.mdx`
- Contract freeze: `docs/superpowers/specs/2026-07-20-existing-agents-contracts.md`
- The MCP door (`docs-site/capabilities/mcp.mdx`) remains the
  third-party-agent story; this seam is in-process.
