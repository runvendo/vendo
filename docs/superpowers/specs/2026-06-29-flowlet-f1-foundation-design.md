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
2. **Reuse the `ai` SDK protocol directly.** The public stream contract **is** the `ai` SDK's `UIMessage` / `UIMessagePart` taxonomy; Flowlet-specific pieces (UI render directives, approvals) ride on its first-class typed `data-*` part extension mechanism. We do not invent a parallel vocabulary or maintain an adapter. Accepted trade-off: a soft coupling to the `ai` SDK's shape and versioning — judged worth it for the speed/reuse, since F2 runs the `ai` SDK natively and the realistic alternative runtimes (Mastra, LangGraph) already emit `ai`-SDK-compatible streams. (This reverses an earlier "own thin protocol" recommendation that was never actually chosen.)
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
**Shaped to mirror the MCP tool definition** so MCP tools (and Composio integrations, which expose MCP) map in with near-zero friction; MCP is a first-class *source* of tools, ingested via an adapter. `FlowletTool` adds `execute` for in-process / frontend tools (the ergonomic path for app-defined tools).

```ts
interface FlowletTool<I, O> {
  name: string
  description: string
  inputSchema: StandardSchema<I>          // JSON-Schema-convertible (MCP uses JSON Schema)
  outputSchema?: StandardSchema<O>
  annotations?: ToolAnnotations           // reuse MCP hints (see below)
  permission?: unknown                    // open slot for any custom gating metadata
  execute(input: I, ctx: ToolContext): Promise<O>   // ctx carries the (opaque) principal
}

// Reuse MCP's standard annotation vocabulary as the broad permission signal.
type ToolAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}
```

**Permission model is broad by construction:** F1 owns only the *mechanism* (approval request/response/edit/expire, §5.5) and these standard *hints*; the *policy* — how hints translate to "gate or not," and any richer strategy (ask-once-remember, role-based, threshold) — is a pluggable concern owned by F2. This replaces the earlier coarse `safe|read|mutate` enum (too crude and premature) with reuse + openness.

### 5.3 UI composition model
A node tree, each node carrying a stable `id`. All nodes render in the stage; `source` is provenance. Two variants only — a named component, or a **fully opaque** generated payload. F1 invents **no** layout/description DSL and **no** envelope of its own; F3 chooses the generated format (and adds versioning then).

```ts
type UINode =
  | { id: string; kind: "component"; source: "prewired" | "host"; name: string; props: unknown; children?: UINode[] }
  | { id: string; kind: "generated"; payload: unknown }   // fully opaque; format chosen by F3
```

**Fast meshing of pre-built + generated is the design goal:** because a `component` node is just a name+props reference (instant, no generation) and a `generated` node sits beside or nests with it in the *same* tree and *same* sandbox stage, the agent can drop a pre-built `OrderCard` next to a custom generated bit in one response. This makes **"can the generated format reference registered components by name inside its tree"** a hard selection criterion when F3 picks the format (A2UI does this well).

### 5.4 Chat / stream protocol
**The protocol is the `ai` SDK's `UIMessage` stream**, reused directly. We do **not** define a parallel union or an adapter — F2 (running the `ai` SDK) emits these parts natively, and `flowlet-react` consumes them via `useChat`. Flowlet-specific pieces are added as the `ai` SDK's first-class typed `data-*` parts:

- **Native `ai` SDK parts we rely on:** text, tool-input/output (incl. tool-output-denied), error. (Reasoning, usage, source, file parts are available but not required by F1.)
- **Flowlet `data-*` parts (our additions):**
  - `data-ui` — carries a `UINode` to render in the stage (full-node replacement: a new `data-ui` with the same node `id` replaces it). Incremental partial-prop streaming is deferred to F3.
  - `data-approval` — the approval request (§5.5).
- **Run/thread identity + version:** carried on the `UIMessage` metadata (`runId`, `threadId`, `schemaVersion`) — cheap now, a migration later.

**Client → server (return channel):** approval responses and sandbox actions ride the `ai` SDK's existing client→server message path (`data-approval-response`, `data-action`).

> Why this shape: the `ai` SDK already models text/tool/error and gives a typed `data-*` extension slot purpose-built for app-specific parts — so reusing it directly is less code than an own-union-plus-adapter and removes drift risk entirely. `data-*` parts can be persistent (in history) or transient (status only), which we use for durable UI vs ephemeral state.

### 5.5 Approval / human-in-the-loop
**One channel only:** approval is carried as `data-*` parts on the same `ai` SDK message stream — `data-approval` out, `data-approval-response` back — correlated by a stable `approvalId`. There is **no** imperative `resolveApproval()` side method (a run-stateful second door that breaks under serverless, refresh, and resumed runs). Responses may **edit** the arguments (full replacement) and requests **expire**.

```ts
type ApprovalRequest  = { approvalId: string; toolCallId: string; prompt: string; input: unknown; expiresAt?: number }  // as data-approval
type ApprovalResponse = { approvalId: string; approved: boolean; editedInput?: unknown }                                // as data-approval-response
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
    messages: UIMessage[]          // ai SDK UIMessage history (multi-turn)
    tools: FlowletTool[]
    system?: string
    principal?: unknown            // opaque per-user identity/credentials; F2 defines the shape
    signal: AbortSignal            // cancellation
    onClientPart?: (p: ClientPart) => void   // data-approval-response + data-action, in-band
  }): AsyncIterable<UIMessageChunk>   // the ai SDK UI message stream (incl. our data-* parts)
}
```

The **stub agent** emits a scripted `ai` SDK `UIMessage` stream — text, a tool call, a `data-approval` request, and a `data-ui` node — with no LLM, so F3 and the React layer can build against a realistic stream immediately. It is a development fixture, not a runtime.

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
| Stub agent (scripted `ai` SDK `UIMessage` stream) | Real |
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
- **Consent/audit:** any tool the policy gates emits a `data-approval` request; every sandbox action routes through the action chokepoint. These two are the only paths to side effects.

## 9. Testing

Pointed at contract *risk*, not contract *volume*:
- **Valid `ai` SDK stream:** assert the stub emits a well-formed `ai` SDK `UIMessage` stream including our `data-ui` / `data-approval` parts — ordering, matched node `id`s, approval correlation by `approvalId`, cancellation via `AbortSignal`.
- **MCP tool mapping:** assert an MCP tool definition maps cleanly to/from `FlowletTool` (the first-class ingestion path).
- **React seam:** mount `FlowletProvider` + stub agent + the example registry; assert the loop completes through an approval (request → response → result) via `useChat`.
- **Schema boundary:** assert schemas at the LLM/tool boundary are JSON-Schema-convertible.

## 10. Reuse summary

| Concern | Decision |
|---|---|
| Schema | Standard Schema (Zod default); JSON-Schema-convertible at the LLM/tool edge |
| Engine (F2) | Vercel `ai` SDK, runtime swappable behind `FlowletAgent` |
| Protocol | Reuse the `ai` SDK `UIMessage` stream directly + typed `data-*` parts (`data-ui`, `data-approval`); no own union, no adapter |
| Tools | Shape `FlowletTool` like the MCP tool def; MCP is a first-class tool source (ingested via adapter) |
| Permissions | Reuse MCP tool annotations + open `permission` slot; mechanism in F1, policy in F2 |
| Sandbox bridge (F3) | mcp-ui / MCP Apps — bridge primitive, validated by the F3a spike |
| Pre-wired components (F4) | Crayon (MIT) |
| Generated format (F3) | A2UI / Crayon / OpenUI Lang — chosen in F3 (must support referencing registered components by name) |

## 11. Risks and cons (honest)

1. **Fully-sandboxed is the heaviest path.** The theme + app-state bridge is real, ongoing engineering, and host components must be adapted to receive data over the bridge instead of app context. Deferred to F3, but the direction commits us to it.
2. **`ai` SDK coupling (accepted).** Reusing the `ai` SDK `UIMessage` protocol directly means its major-version changes touch our public contract. Chosen deliberately over an own-union+adapter for speed/reuse; revisit only if a genuinely non-`ai`-SDK runtime becomes a priority. mcp-ui / MCP Apps (spec finalizing mid-2026) stays behind F3.
3. **The `generated`-node format is unchosen and fully opaque.** Intentional (F3 decides), but it leaves one contract variant opaque until then — and pushes the "reference components by name" meshing requirement onto F3's format choice.

## 12. Future (not in F1; Layer 5 vision)

Tracked separately so nothing is lost while the board stays focused on F1–F3:
- **F4 · Pre-wired component library** (wrap Crayon into the registry)
- **F5 · Product surface / shell** (widget / modal / page — the native chat shell)
- **F6 · Memory** (user actions + account history)
- **F7 · Automations** (cron / webhooks / saved flowlets)

## 13. Open questions

- The exact `principal` shape — opaque in F1 (edit 4), defined when F2 wires Composio per-user auth.
- The `generated` payload's concrete format + versioning (A2UI / Crayon / OpenUI) — chosen and added in F3 (F1 keeps it fully opaque).
- Host-component provisioning model — the subject of the F3a spike (decision #9).
- Whether the example app should also demonstrate a `generated` node against the stub, or only `component` nodes.

## 14. Proposed Linear board (pending, not yet applied)

- Revise ENG-174 / ENG-176 / ENG-177 bodies to match this design.
- Repurpose ENG-177 → **F3a · Sandbox runtime + bridge** (opens with the host-component provisioning spike, decision #9); create **F3b · Gen-UI renderer + declarative format**.
- Create **F4 · Pre-wired component library** and **F5 · Product surface / shell**.
- F6 / F7 captured here in §12 rather than ticketed now.
