# Flowlet F1 — Foundation + Contracts (Design)

- **Issue:** ENG-174 (F1 · Flowlet foundation + contracts)
- **Date:** 2026-06-29
- **Status:** Approved design, pending spec review
- **Blocks:** F2 (agent core + Composio), F3 (generative UI engine)

## 1. What Flowlet is

Flowlet is an agentic SDK that drops into a host web app. A chat-style agent calls tools and renders UI to help a user get what they need or create the UI they need. Its differentiator is rendering UI from **three sources under one model**: pre-wired Flowlet components, the host app's own components, and arbitrary LLM-generated UI.

F1 is the foundation. It defines the contracts the rest of Flowlet builds against and ships stubs so the downstream tracks have stable seams. No demo-specific content — this builds Flowlet itself.

## 2. The layer model and ownership

Flowlet is a stack of layers. Understanding which track owns each layer is the key to scoping F1.

| Layer | Responsibility | Owner |
|---|---|---|
| 0 · Protocol | The typed event vocabulary the agent and UI speak | **F1** |
| 1 · Provider | Make any LLM vendor look the same | Reuse `ai` SDK (in F2) |
| 2 · Engine | Run the model→tool→model loop, stream output | F2 on `ai` SDK |
| 3 · Safety | Gate dangerous actions; one audited action chokepoint | **F1** contract, F2 enforces |
| 4 · Gen-UI | Render agent UI safely in the sandbox | **F1** seam, F3 builds |
| 5 · Product | Chat shell, memory, integrations, automations | F4/F5+ |

F1 owns Layer 0 in full, the contracts for Layers 3 and 4, and ships stubs so F2 and F3 can build in parallel without waiting on each other.

## 3. Locked decisions

These were settled during brainstorming and a three-reviewer design critique.

1. **Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, Zod.
2. **Own thin protocol, AG-UI-aligned.** F1 defines its own discriminated-union stream contract whose semantics mirror the open AG-UI event model, but does **not** depend on the `@ag-ui` packages (pre-1.0, vendor-controlled). This keeps the runtime swappable and avoids coupling the public seam to a moving spec.
3. **Engine reuse, runtime swappable.** F2 builds the engine on the Vercel `ai` SDK (provider-agnostic, best-in-class partial-object streaming). The `FlowletAgent` interface keeps the runtime swappable — raw Anthropic SDK, Mastra, or anything else can implement it.
4. **All agent-rendered UI is sandboxed.** Every piece of UI the agent renders runs inside a sandbox, never in the host's trusted tree. The Flowlet shell stays native. Rationale: one airtight security boundary and the ability to run any code uniformly. Cost accepted: theme and app-state must be proxied into the sandbox.
5. **One stage per surface.** The whole composition tree for an agent surface renders inside a **single** sandbox iframe — not one iframe per component. Components share theme/CSS/layout and overflow naturally; the iframe cost is paid once per surface. This is how artifact systems work and is what makes "fully sandboxed" practical.
6. **Composition tree, source per node.** A rendered UI is a tree; each node declares its `source`. AI-generated *structure* is data (safe); trusted components are referenced by name; genuinely custom *code* is a leaf. All of it renders in the one stage; `source` tags provenance for provisioning, not trust.
7. **Reuse the sandbox standard.** F3's sandbox bridge builds on **mcp-ui / MCP Apps** (already standardizes sandboxed iframe + postMessage JSON-RPC + correlation + audited dispatch). F1 does not hand-roll a bridge wire format.
8. **Format-agnostic declarative lane.** F1 carries generated UI as one opaque node variant; F3 picks the concrete format (A2UI, Crayon's spec, or OpenUI Lang).

## 4. Package layout

- **`flowlet-core`** — pure TypeScript. All contracts in §5, plus a scripted stub agent. Zero React.
- **`flowlet-react`** — `FlowletProvider`, the component registry, a `useFlowletChat` hook, and a stub renderer. Thin.
- **`example/`** — one page wiring the provider + stub agent + a couple of registered components, proving the loop runs end-to-end.

## 5. The contracts

The design critique trimmed speculative depth and tightened the few shared seams. The principle: **cut the plumbing, tighten the semantics.** Sketches below are illustrative shapes, not final code.

### 5.1 Schema layer
Contract fields are typed against the **Standard Schema** interface (the neutral spec Zod, Valibot, and ArkType all implement) so consumers aren't locked to one validation library. **Zod is the default implementation** used in Flowlet's own stubs and examples. Schemas convert to JSON Schema only at the single LLM boundary. No custom abstraction layer — Standard Schema already is the abstraction.

### 5.2 Tool interface
A named, schema-bearing action. The `danger` level drives consent. Reused by both Flowlet tools and Composio integrations (F2).

```ts
type Danger = "safe" | "read" | "mutate"   // "mutate" requires approval
interface FlowletTool<I, O> {
  name: string
  description: string
  inputSchema: StandardSchema<I>
  outputSchema?: StandardSchema<O>
  danger: Danger
  execute(input: I, ctx: ToolContext): Promise<O>   // ctx carries session/principal
}
```

### 5.3 UI composition model
A node tree, each node carrying a stable `id` (required for partial-prop streaming). All nodes render in the stage; `source` is provenance.

```ts
type UINode =
  | { id: string; kind: "component"; source: "prewired" | "host"; name: string; props: unknown; children?: UINode[] }
  | { id: string; kind: "layout"; type: string; props?: unknown; children: UINode[] }
  | { id: string; kind: "generated"; payload: unknown }   // opaque; format chosen by F3
```

The `generated` node carries a capability hint, but capability *semantics* (network allowlist, dispatch permission, display mode) are defined by F3 at the sandbox boundary, not frozen here.

### 5.4 Chat / stream protocol
A discriminated union of stream parts, shaped as a **thin superset of the `ai` SDK's `UIMessagePart`** so F2's default runtime maps onto it via an adapter. Only the genuinely-new parts (approval, UI, state) are Flowlet-specific. Parts keep slots for `usage` and `reasoning` so provider info survives a runtime swap.

Server → client parts (minimal set):
`run-start` · `text-start/delta/end` · `tool-input-start/available` · `tool-output-available/denied` · `approval-request` · `ui` · `ui-delta` · `state-snapshot/delta` · `reasoning` · `usage` · `run-finish` · `error`

Client → server return channel:
`approval-response` · `action`

**Pinned `ui-delta` semantic:** a `ui-delta` carries the latest partial parse of a target node's props (addressed by node `id`) and **replaces** them. Props may be partial or schema-invalid mid-stream; the renderer tolerates this and validates against the node's `propsSchema` only when the node is finalized.

### 5.5 Approval / human-in-the-loop
Correlated by a stable `approvalId` so parallel tool calls don't mismatch. Supports edited arguments, not just approve/deny.

```ts
type ApprovalRequest  = { type: "approval-request"; approvalId: string; toolCallId: string; prompt: string; input: unknown }
type ApprovalResponse = { type: "approval-response"; approvalId: string; approved: boolean; editedInput?: unknown }
```

### 5.6 Action chokepoint
The single semantic seam every sandbox action routes through for consent and audit. F1 defines the **shape**; F3 provides the transport (mcp-ui JSON-RPC over postMessage). Correlated request→response, carrying origin node + capability + an error case.

```ts
type DispatchAction = (req: {
  requestId: string
  originNodeId: string
  action: string
  payload?: unknown
  capability?: unknown
}) => Promise<{ result: unknown } | { error: { code: string; message: string } }>
```

### 5.7 Agent interface (+ stub)
Runtime-agnostic. The **input is fully specified** so F2 can do multi-turn, per-user auth (Composio), and cancellation without a contract break.

```ts
interface FlowletAgent {
  run(input: {
    messages: Message[]        // multi-turn history
    tools: FlowletTool[]
    system?: string
    session: Principal         // per-user identity/credentials for tools + integrations
    signal: AbortSignal        // cancellation
  }): AsyncIterable<FlowletPart>
  resolveApproval(approvalId: string, response: { approved: boolean; editedInput?: unknown }): void
}
```

The **stub agent** emits a scripted `FlowletPart` stream — text, a tool call, an approval request, and a UI node — with no LLM, so F3 and the React layer can build against a realistic stream immediately.

### 5.8 Component registry
A descriptor the renderer resolves by name and the agent reads to know what it may emit. Eager references for v1; lazy `load()`/`needs` provisioning is deferred until F3 proves it's needed.

```ts
interface RegisteredComponent {
  name: string
  description: string          // drives LLM selection
  propsSchema: StandardSchema<unknown>
  source: "prewired" | "host"
}
```

## 6. What is real vs stub in F1

| Piece | F1 ships |
|---|---|
| All contracts in §5 (types + Standard Schema validators, Zod default) | Real |
| Stub agent (scripted `FlowletPart` stream) | Real |
| `FlowletProvider` + registry + `useFlowletChat` | Real |
| Stub renderer (renders `component` nodes; placeholder for `generated`) | Real (stub) |
| Real iframe stage, theme/state proxy, declarative renderer | F3 |
| Real LLM engine, Composio, approval enforcement | F2 |

## 7. Data flow (one request, traced through the stub)

1. The shell calls `useFlowletChat().send(message)`.
2. `flowlet-react` invokes the stub `FlowletAgent.run(...)`.
3. The stub yields: `run-start` → `text-start/delta/end` → `tool-input-available` → `approval-request`.
4. The hook surfaces the approval; the shell renders a consent card; the user approves; the hook calls `resolveApproval`.
5. The stub yields `tool-output-available` → a `ui` part with a `component` node → `run-finish`.
6. The stub renderer resolves the node name in the registry and renders the placeholder stage. (F3 later replaces this with the real sandboxed stage.)

This proves every seam — streaming, tools, approval correlation, UI nodes, registry resolution — without an LLM or a sandbox.

## 8. Error handling, cancellation, consent

- **Errors:** an `error` stream part with a typed code (provider / tool / validation / sandbox). The sandbox bridge error taxonomy comes from mcp-ui (F3), not F1.
- **Cancellation:** `AbortSignal` on `run()` propagates to the provider stream and running tools; a pending approval is abortable.
- **Consent/audit:** every mutating tool emits an `approval-request`; every sandbox action routes through `DispatchAction`. These two are the only paths to side effects.

## 9. Testing

- **Contract validation:** Vitest unit tests asserting each schema accepts/rejects the right shapes and that JSON Schema conversion at the LLM boundary is stable.
- **Stub stream conformance:** a test that drives the stub agent and asserts the emitted `FlowletPart` sequence is well-formed (correct ordering, matched ids, approval correlation).
- **React seam:** a test mounting `FlowletProvider` + stub agent + the example registry and asserting the loop completes through an approval.

## 10. Reuse summary

| Concern | Decision |
|---|---|
| Schema | Zod (implements Standard Schema); JSON Schema at LLM edge |
| Engine (F2) | Vercel `ai` SDK, runtime swappable behind `FlowletAgent` |
| Protocol | Own thin superset of `ai` SDK parts; AG-UI-aligned semantics; no `@ag-ui` dependency |
| Sandbox bridge (F3) | mcp-ui / MCP Apps |
| Pre-wired components (F4) | Crayon (MIT) |
| Declarative format (F3) | A2UI / Crayon / OpenUI Lang — chosen in F3 |

## 11. Risks and cons (honest)

1. **Fully-sandboxed is the heaviest path.** The theme + app-state bridge is real, ongoing engineering, and host components must be adapted to receive data over the bridge instead of app context. Deferred to F3, but the direction commits us to it.
2. **Pre-1.0 dependencies.** `ai` SDK (major churn), mcp-ui / MCP Apps (spec finalizing mid-2026). Mitigated by keeping them behind our own contracts.
3. **The `generated`-node format is unchosen.** Intentional (F3 decides), but it leaves one contract variant opaque until then.

## 12. Future (not in F1; Layer 5 vision)

Tracked separately so nothing is lost while the board stays focused on F1–F3:
- **F4 · Pre-wired component library** (wrap Crayon into the registry)
- **F5 · Product surface / shell** (widget / modal / page — the native chat shell)
- **F6 · Memory** (user actions + account history)
- **F7 · Automations** (cron / webhooks / saved flowlets)

## 13. Open questions

- The exact `Principal` / session shape — minimal in F1, likely refined when F2 wires Composio per-user auth.
- Whether `state-snapshot/delta` uses JSON Patch (AG-UI's choice) or a simpler replace; defaulting to JSON Patch unless F2/F3 push back.
- Whether the example app should also demonstrate a `generated` node against the stub, or only `component` nodes.

## 14. Proposed Linear board (pending, not yet applied)

- Revise ENG-174 / ENG-176 / ENG-177 bodies to match this design.
- Repurpose ENG-177 → **F3a · Sandbox runtime + bridge**; create **F3b · Gen-UI renderer + declarative format**.
- Create **F4 · Pre-wired component library** and **F5 · Product surface / shell**.
- F6 / F7 captured here in §12 rather than ticketed now.
