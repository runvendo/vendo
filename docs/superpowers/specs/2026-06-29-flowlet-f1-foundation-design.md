# Flowlet F1 — Foundation + Contracts (Design)

- **Issue:** ENG-174 (F1 · Flowlet foundation + contracts)
- **Date:** 2026-06-29
- **Status:** Revised after a 5-reviewer critique (3 Claude + 2 Codex); pending final spec review
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
7. **Reuse the sandbox standard.** F3's sandbox bridge evaluates **mcp-ui / MCP Apps** (which standardizes sandboxed iframe + postMessage JSON-RPC + correlation + audited dispatch) as the bridge *primitive*, validated by an F3a spike — not assumed as the internal rendering model. F1 does not hand-roll a bridge wire format.
8. **Format-agnostic generated lane.** F1 carries generated UI as one opaque (but version-stamped) node variant; F3 picks the concrete format (A2UI, Crayon's spec, or OpenUI Lang). F1 does **not** invent any UI layout/description DSL of its own.
9. **Host-component provisioning is an F3a spike, not the F1 registry.** Because host components render inside the sandbox, making them work (bundle loading, CSS/tokens, state proxy, sizing, focus, a11y) is a hard, central contract. F1's registry is *descriptors only*; the real provisioning contract is owned by F3a and opens with a spike to prove the one-stage model before committing.

## 4. Package layout

- **`flowlet-core`** — pure TypeScript. All contracts in §5, plus a scripted stub agent. Zero React.
- **`flowlet-react`** — `FlowletProvider`, the component registry, a `useFlowletChat` hook, and a stub renderer. Thin.
- **`example/`** — one page wiring the provider + stub agent + a couple of registered components, proving the loop runs end-to-end.

## 5. The contracts

The design critique trimmed speculative depth and tightened the few shared seams. The principle: **cut the plumbing, tighten the semantics.** Sketches below are illustrative shapes, not final code.

### 5.1 Schema layer
Contract fields are typed against the **Standard Schema** interface (the neutral spec Zod, Valibot, and ArkType all implement) so consumers aren't locked to one validation library. **Zod is the default implementation** used in Flowlet's own stubs and examples. No custom abstraction layer — Standard Schema already is the abstraction.

**Caveat (edit 10):** Standard Schema only standardizes *validation*; JSON Schema conversion (needed to hand schemas to the LLM) is best-effort across libraries. F1 therefore **requires schemas used at the LLM boundary to be JSON-Schema-convertible** (or simply uses Zod's conversion there). This keeps the public API library-neutral while guaranteeing the tool/LLM boundary works.

### 5.2 Tool interface
A named, schema-bearing action. `requiresApproval` drives consent; richer danger *policy* (severity, scope, reversibility) is deferred to F2 once real tools exist, carried meanwhile as opaque `risk` metadata. Reused by both Flowlet tools and Composio integrations (F2).

```ts
interface FlowletTool<I, O> {
  name: string
  description: string
  inputSchema: StandardSchema<I>
  outputSchema?: StandardSchema<O>
  requiresApproval: boolean        // edit 3: replaces the coarse "safe|read|mutate" enum
  risk?: unknown                   // optional, opaque; F2 defines the policy model
  execute(input: I, ctx: ToolContext): Promise<O>   // ctx carries the (opaque) principal
}
```

> Edit 3: the previous `Danger = "safe" | "read" | "mutate"` enum was both too coarse (a read can be sensitive; "mutate" lumps trivial edits with money movement) and premature (policy before real tools). A boolean + opaque metadata is enough for F1; F2 designs the real policy.

### 5.3 UI composition model
A node tree, each node carrying a stable `id`. All nodes render in the stage; `source` is provenance. Two variants only — a named component, or an opaque-but-version-stamped generated payload. F1 invents **no** layout/description DSL of its own (edit 1); nesting/arrangement comes with whatever format F3 chooses for the `generated` lane.

```ts
type UINode =
  | { id: string; kind: "component"; source: "prewired" | "host"; name: string; props: unknown; children?: UINode[] }
  | { id: string; kind: "generated"; envelope: GeneratedEnvelope }

// edit 7: opaque payload, but stamped on the outside so F3 can evolve the format without breaking F1
interface GeneratedEnvelope {
  format: string            // e.g. "a2ui" | "crayon" | "openui"  (chosen in F3)
  formatVersion: string
  capabilities?: unknown    // hint only; capability *semantics* are defined by F3 at the sandbox boundary
  payload: unknown          // opaque to F1
}
```

> Edit 1: the previous `layout` node was a custom UI DSL in disguise, which contradicted the "F3 picks the format" decision. Removed. Edit 7: the `generated` payload stays opaque to F1 but is wrapped in a labeled, versioned envelope.

### 5.4 Chat / stream protocol
A discriminated union of stream parts. It is **not a new vocabulary** — it is a thin, explicit **adapter/superset over the `ai` SDK's `UIMessagePart`** (edit 8): F1 ships the adapter that maps `ai`-SDK parts → Flowlet parts plus a **conformance test** that enforces the mapping, so "aligned" is verified, not aspirational. Every part carries a `schemaVersion`; the stream carries a `runId` and `threadId` (edit 9 — cheap now, a migration later).

**Server → client parts (core set only — edit 5):**
`run-start` (with `runId`, `threadId`, `schemaVersion`) · `text-delta` · `tool-input-available` · `tool-output-available/denied` · `approval-request` · `ui` (full UINode) · `run-finish` · `error` (typed code: provider / tool / validation / sandbox)

**Client → server return channel:**
`approval-response` · `action`

**Named deferred extension points** (NOT in F1; added when the consuming track needs them, as non-breaking union members): `state-snapshot/delta`, `reasoning`, `usage`, fine-grained `text-start/end` + `tool-input-start/delta`, and `ui-delta`.

> Edit 6: F1 uses **full-node replacement** — a new `ui` part replaces the node with the same `id`. The incremental partial-prop streaming (`ui-delta`) was under-specified (it referenced a `propsSchema` that lives on the registry, not the node, and defined no "finalized" event) and would have forced a break; it is owned and designed by F3.

### 5.5 Approval / human-in-the-loop
**One channel only (edit 2):** approval flows entirely through the stream's return channel — request out, response back, correlated by a stable `approvalId`. There is **no** imperative `resolveApproval()` side method (it was a run-stateful second door that breaks under serverless, refresh, and resumed runs). Responses may **edit** the arguments (full replacement) and requests **expire**.

```ts
type ApprovalRequest  = { type: "approval-request"; approvalId: string; toolCallId: string; prompt: string; input: unknown; expiresAt?: number }
type ApprovalResponse = { type: "approval-response"; approvalId: string; approved: boolean; editedInput?: unknown }
```

### 5.6 Action chokepoint
The single semantic seam every sandbox action routes through for consent and audit. F1 defines the **semantic shape** (origin node + capability + error) because consent/audit is shared semantics F1 must own; the **transport is owned by F3** (validated against mcp-ui JSON-RPC over postMessage in the F3a spike). Correlated request→response.

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
Runtime-agnostic. The input names the seams F2 needs — multi-turn, per-user auth, cancellation — but keeps the **`principal` opaque/optional** until F2 (Composio) proves its real shape (edit 4 — declaring a shape we admit we don't know yet just guarantees a break). Approvals come back through the **stream return channel**, not an imperative method (edit 2).

```ts
interface FlowletAgent {
  run(input: {
    messages: Message[]            // multi-turn history
    tools: FlowletTool[]
    system?: string
    principal?: unknown            // opaque per-user identity/credentials; F2 defines the shape
    signal: AbortSignal            // cancellation
    onClientPart?: (p: FlowletClientPart) => void   // approval-response + sandbox action, in-band
  }): AsyncIterable<FlowletPart>
}
```

The **stub agent** emits a scripted `FlowletPart` stream — text, a tool call, an approval request, and a UI node — with no LLM, so F3 and the React layer can build against a realistic stream immediately. It is a development fixture, not a runtime.

### 5.8 Component registry
**Descriptors only (edit 9).** This is the LLM-facing *menu* — what the agent may emit and how the renderer resolves a name. It is explicitly **not** the host-component provisioning contract (bundle loading, CSS/tokens, state proxy, sizing, focus, a11y); making a host component actually run inside the sandbox is owned by **F3a** and opens with a spike (decision #9). Eager references for v1; lazy provisioning is deferred.

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
| Stub renderer (renders `component` nodes; placeholder for `generated`) — **non-production, no security boundary**; API kept close to the future stage seam | Real (stub) |
| Real iframe stage, theme/state proxy, declarative renderer | F3 |
| Real LLM engine, Composio, approval enforcement | F2 |

## 7. Data flow (one request, traced through the stub)

1. The shell calls `useFlowletChat().send(message)`.
2. `flowlet-react` invokes the stub `FlowletAgent.run(...)`.
3. The stub yields: `run-start` → `text-start/delta/end` → `tool-input-available` → `approval-request`.
4. The hook surfaces the approval; the shell renders a consent card; the user approves; the hook sends an `approval-response` back through the return channel.
5. The stub yields `tool-output-available` → a `ui` part with a `component` node → `run-finish`.
6. The stub renderer resolves the node name in the registry and renders the placeholder stage. (F3 later replaces this with the real sandboxed stage.)

This proves every seam — streaming, tools, approval correlation, UI nodes, registry resolution — without an LLM or a sandbox.

## 8. Error handling, cancellation, consent

- **Errors:** an `error` stream part with a typed code (provider / tool / validation / sandbox). The sandbox bridge error taxonomy comes from mcp-ui (F3), not F1.
- **Cancellation:** `AbortSignal` on `run()` propagates to the provider stream and running tools; a pending approval is abortable.
- **Consent/audit:** every tool with `requiresApproval` emits an `approval-request`; every sandbox action routes through the action chokepoint. These two are the only paths to side effects.

## 9. Testing

Pointed at contract *risk*, not contract *volume*:
- **`ai`-SDK adapter conformance (edit 8):** the load-bearing test — assert the adapter round-trips `ai`-SDK `UIMessagePart`s ↔ Flowlet parts, so "aligned" can't silently drift.
- **Stub stream conformance:** drive the stub agent and assert the `FlowletPart` sequence is well-formed — ordering, matched `id`s/`runId`, approval correlation by `approvalId`, cancellation via `AbortSignal`.
- **React seam:** mount `FlowletProvider` + stub agent + the example registry; assert the loop completes through an approval (request → `approval-response` → result).
- **Schema boundary:** assert schemas at the LLM boundary are JSON-Schema-convertible.

## 10. Reuse summary

| Concern | Decision |
|---|---|
| Schema | Zod (implements Standard Schema); JSON Schema at LLM edge |
| Engine (F2) | Vercel `ai` SDK, runtime swappable behind `FlowletAgent` |
| Protocol | Adapter/superset over `ai` SDK parts (with conformance test); AG-UI-aligned semantics; no `@ag-ui` dependency |
| Sandbox bridge (F3) | mcp-ui / MCP Apps — bridge primitive, validated by the F3a spike |
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

- The exact `principal` shape — opaque in F1 (edit 4), defined when F2 wires Composio per-user auth.
- The `generated` envelope's concrete `format` (A2UI / Crayon / OpenUI) — chosen in F3.
- Host-component provisioning model — the subject of the F3a spike (decision #9).
- Whether the example app should also demonstrate a `generated` node against the stub, or only `component` nodes.

## 14. Proposed Linear board (pending, not yet applied)

- Revise ENG-174 / ENG-176 / ENG-177 bodies to match this design.
- Repurpose ENG-177 → **F3a · Sandbox runtime + bridge** (opens with the host-component provisioning spike, decision #9); create **F3b · Gen-UI renderer + declarative format**.
- Create **F4 · Pre-wired component library** and **F5 · Product surface / shell**.
- F6 / F7 captured here in §12 rather than ticketed now.
