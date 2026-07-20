# Use Vendo with your existing agent — design

**Date:** 2026-07-20
**Status:** Approved (brainstorm with Yousef, this session)
**Deliverables:** a first-class in-process BYO-agent seam, two examples
(AI SDK, Mastra) built on each framework's canonical starter, a new docs-site
section, and a full-journey e2e (starter → `vendo init` → live app creation).

## Problem

Everything today assumes Vendo *is* the agent. A company with an existing
Mastra or AI SDK agent has no in-process way to add Vendo. The only adjacent
paths: the MCP door (built for third-party agents, OAuth dance, experimental),
headless UI hooks (skip Vendo's UI, still Vendo's loop), BYO-LLM (swap the
model, not the loop), and the `AgentRunner` core seam (exists at the block
layer, hard-wired to `agent.asRunner()` in the umbrella, unreachable). The
guard-bound tool wrapping (`buildAgentTools`) is internal to `@vendoai/agent`.

## What a BYO-agent host gets

All three, one contract (decision: all selected, seam designed for all):

1. **Guarded tools in their loop** — host actions, connected-account tools,
   each call routed through policy → approval → audit.
2. **Generated UI in their chat** — Vendo apps render inline in their own
   chat surface via embed components.
3. **Vendo as a delegate** — a single tool that hands Vendo a whole task,
   backed by the existing `AgentRunner` seam.

## Composition

The host runs `createVendo` and mounts the wire exactly as today. What they
drop is Vendo's chat loop and chat UI. The wire keeps serving apps, approvals,
and connected accounts to the embeds. "Vendo minus the conversation."

Two models, deliberately: their agent keeps its own model; Vendo's `model`
seam still powers app generation and the delegate. The existing key ladder /
Cloud fallback means zero extra config in the common case.

## Server seam

Two new subpath exports on the umbrella, both thin format shims over one new
framework-neutral tool-pack core in `@vendoai/agent`. The core is a promotion
of the internal `buildAgentTools` — the same guard-bound wrapping Vendo's own
loop uses, not a parallel path. Invariant preserved: no tool reachable from a
BYO loop has an unguarded route.

- `@vendoai/vendo/ai-sdk` → `vendoTools(vendo, { principal, include?, exclude? })`
  returns an AI SDK v5 `ToolSet`. Built per-request (tool execution needs a
  principal-scoped `RunContext`).
- `@vendoai/vendo/mastra` → same pack in Mastra `createTool` shape, for the
  `Agent({ tools })` map. Mastra agent definitions are static, so the shim
  resolves the principal lazily per call from Mastra's runtime context.
  `@mastra/core` becomes an optional peer dep used only by this subpath.

The umbrella already depends on `ai`, so the AI SDK shim adds no deps.

## The tool pack

Namespaced `vendo_*` to avoid collisions:

- **Host actions** — everything registered with Vendo (server actions,
  route-bound tools, connected-account tools), guard-wrapped per call.
- **`vendo_create_app`** — generate UI. Returns fast with an app ref; the
  build streams over the wire, so the host loop is never blocked on
  generation.
- **`vendo_delegate`** — whole-task delegation via `agent.asRunner()`;
  returns the run report summary plus refs to anything produced.
- `include`/`exclude` filters the pack.

## Embed contract

Tool outputs are small versioned JSON envelopes (same pattern as the MCP
door's `vendo/open-in-product@1` card):

- `vendo/app-ref@1` `{ appId, title }` → `<VendoAppEmbed>`
- `vendo/approval-ref@1` `{ approvalId, summary }` → `<VendoApprovalEmbed>`
- plain data → the action executed cleanly; the agent consumes the result
  like any tool output.

### Approval semantics in a foreign loop

A guarded call needing approval does not throw and does not block the loop.
The tool returns the approval-ref envelope immediately; the model sees
"pending — the user must approve in the UI." The pending call parks
server-side on the wire's existing approve-resume machinery. On approve, the
wire executes the parked call and the embed renders the outcome inline; the
agent learns the result on a later turn if it matters (same eventual
consistency as Vendo's abandoned-approval handling — new venue, not new
semantics). Deny resolves the embed to "declined" and discards the parked
call; the existing approval TTL/abandonment sweep applies unchanged.

## Client embeds

Three additions to `@vendoai/ui`, built on existing machinery (slot
rendering, build-beat, approval-card):

- `<VendoAppEmbed refValue>` — inline generated app; build-beat while the
  build streams, then the live app. In-app interactions go over the wire,
  not through the host loop.
- `<VendoApprovalEmbed refValue>` — approve/deny; resolves in place to the
  outcome (executed result or "declined"; "expired" for TTL).
- `<VendoToolResult output>` — dispatcher: give it any `vendo_*` tool output
  and it renders the right embed, or nothing for plain data.

Setup: wrap the chat in the existing `VendoProvider` pointed at the wire
(same one-time step the headless hooks require). Auth rides the host session
cookie; theme rides the `--vendo-*` tokens. Failure states render the
underlying components' existing failed/expired vocabulary — no silent blanks.

## Examples

Both start from the framework's canonical starter (decision: implement on
their existing examples), joined to the pnpm workspace under a new top-level
`examples/` root with `workspace:*` deps, covered by turbo
build/test/typecheck/lint. Each README opens with "this is the unmodified
<framework> starter plus these ~N lines" and links its docs guide.

- **`examples/ai-sdk-agent`** — the AI SDK Next.js quickstart chatbot
  (useChat + streamText + weather tool). Vendo diff: `lib/vendo.ts`
  (createVendo + the weather lookup registered as a Vendo action + one
  deliberately risky action, e.g. `sendTripReport`, to exercise approvals),
  the stock wire route, the `vendoTools` spread in `/api/chat`, and the
  `VendoToolResult` case + `VendoProvider` in the chat component.
- **`examples/mastra-agent`** — `create-mastra`'s weather agent, fronted per
  Mastra's own Next.js guide (`@mastra/ai-sdk` → useChat + AI SDK UI). Same
  four touches; the tools spread lands in `Agent({ tools })` via the
  `./mastra` shim. Frontend identical to the AI SDK example — proof the
  embed contract is framework-agnostic.

Demo script (both): normal tool use → "make me a dashboard comparing weather
in 3 cities" → app builds inline → "email the report" → approval card →
approve → executed. All three value props in one thread.

## Docs

New top-level docs-site group **"Use with your existing agent"**:

- `existing-agents/index.mdx` — positioning: what you get, the composition,
  the envelope/embed contract, the two-models note.
- `existing-agents/ai-sdk.mdx`, `existing-agents/mastra.mdx` — diff-by-diff
  walkthroughs mirroring the examples, ending with the demo script.
- Reference: subpath exports on handler-options/reference pages; the three
  components on the UI/hooks reference.
- Cross-links: quickstart + index get an "already have an agent?" fork;
  `capabilities/mcp.mdx`'s aside routes in-process integrators here (the
  door remains the third-party-agent story).
- In-repo `docs/existing-agents.md` mirrors the section so the trees don't
  drift.

## Testing & verification

- **TDD at the seam:** unit tests for the tool-pack core (every pack tool
  routes through the guard — extend the existing conformance-test pattern in
  `@vendoai/agent`; approval parking + resume-on-approve; envelope shapes).
  Per-shim tests: AI SDK `ToolSet` validity; Mastra tool shape against
  `@mastra/core`.
- **Example e2e:** fixture-style test per example (the `fixtures/mcp-e2e`
  precedent) driving one real turn: tool call → envelope → wire resolution.
- **Full-journey e2e (decision: init as-is + scripted diff):** per example,
  env-gated live test: scaffold the fresh framework starter → run current
  `vendo init` for server wiring → apply the example's marked BYO diff
  programmatically → boot → drive a live turn to an actual app creation.
  No init changes in this project; an init existing-agent mode is an
  explicit follow-up candidate.
- **Vendo Cloud e2e:** env-gated live test running one example in full Cloud
  posture — `VENDO_API_KEY` only, no BYO keys: managed inference through the
  gateway, cloud sandbox, cloud connections broker — driven to an actual app
  creation. Proves the adapter rule holds from a BYO-agent loop (Cloud fills
  only unset slots; explicitly passed adapters win) and that `/status`
  reports the cloud postures.
- **Browser evidence:** both examples verified in a real browser with
  screenshots (inline app build, approval card, approve-resume) on the PR.
- Green gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

## Out of scope (explicit)

- `vendo init` existing-agent mode (follow-up).
- Standalone `@vendoai/ai-sdk` / `@vendoai/mastra` packages — subpath exports
  can graduate later without breaking the story (Approach 3, deferred).
- Other frameworks (LangGraph, OpenAI Agents SDK) — the neutral tool-pack
  core is the extension point.
- MCP-door changes.

## Decisions log

| Decision | Choice |
| --- | --- |
| Core value | All three (guarded tools, generated UI, delegate); seam designed for all |
| SDK scope | First-class in-process seam (new public surface) |
| UI in their chat | Tool result → embed component |
| Approvals | Same embed contract; park + resume server-side |
| Examples | `examples/` workspace dir, built on framework canonical starters |
| Docs | New top-level "Use with your existing agent" section |
| Approach | Tool pack + embeds, umbrella subpath exports |
| init | Used as-is in e2e; BYO mode deferred |
| Cloud | Env-gated live e2e in full Cloud posture (VENDO_API_KEY only) |
| Execution | Orchestrated to done/tested/merged without further check-ins (Yousef, 2026-07-20) |
