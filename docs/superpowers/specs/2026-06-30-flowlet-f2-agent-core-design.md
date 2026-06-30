# Flowlet F2 — Agent Core + Composio Integrations (Design)

- **Issue:** ENG-176 (F2 · Agent core + Composio integrations)
- **Date:** 2026-06-30
- **Status:** Designed, approved. Builds on F1 (ENG-174), which is implemented and green.
- **Blocked by:** F1. **Blocks:** D2 (ENG-178).
- **F1 design reference:** `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`

## 0. What F2 is, and a note on this revision

F2 turns F1's stub into a real agent. F1 shipped the contracts (`FlowletAgent`, the `ai` SDK
`UIMessage` stream, the `data-ui` part, the registry) and a scripted stub that already drives the
real loop and native approval with a mock model. F2 swaps the mock model for a real one and adds
the tool sources, the guardrail policy, and per-user auth, all behind the same `FlowletAgent`
interface.

**Revision note.** An earlier draft of this spec built F2 on the Mastra framework. Two independent
reviews returned RECONSIDER, and a docs check confirmed three concrete problems: Mastra cannot emit
the `ai` SDK's native approval parts (it has its own storage-backed suspend/resume), its
function-based approval policy does not work on durable agents (the exact long-term payoff we
wanted), and the draft named the wrong Composio package. Adopting Mastra now also forced a reversal
of F1's native-approval decision and a new storage dependency. We reverted to building F2 directly
on the `ai` SDK v6 agent primitives. Mastra (or any orchestrator) remains a swappable `FlowletAgent`
implementation we can adopt later, per layer, when memory (F6) or durable workflows (F7) actually
need it. This design keeps F1's public contract intact.

No demo-specific content. This builds Flowlet itself.

## 1. Locked decisions

1. **Engine is the `ai` SDK v6, behind `FlowletAgent`.** F2's loop is the SDK's `ToolLoopAgent`
   (equivalently `streamText` with `stopWhen: stepCountIs`). F1's stub already runs this exact loop
   with a mock model, so F2 is finishing it, not rebuilding it. The `FlowletAgent` seam keeps the
   runtime swappable.
2. **F1's native approval contract is preserved unchanged.** Approvals stay on the SDK's native
   HITL: `needsApproval` tools emit `tool-approval-request`, the client answers with
   `addToolApprovalResponse`, and `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`
   auto-resubmits. No custom approval part, no storage dependency. `@flowlet/core` and
   `@flowlet/react` do not change.
3. **Guardrails: LLM judge plus deterministic layers.** Natural-language rules are evaluated by a
   fast LLM judge per candidate call; annotation, role, and threshold layers stay deterministic.
   The composed policy maps onto the SDK as described in section 4.4.
4. **Composio via `@composio/vercel`: full ingestion plus live OAuth.** Real per-user tool fetch,
   managed OAuth connect flow, and tool execution, returning ai-SDK-format tools. Tests run offline
   against a mock toolset; the live path is gated behind env keys.
5. **Provider-agnostic, Anthropic-first.** The model is swappable; the default is Anthropic (Opus).
   Provider choice never leaks into the public contract.

## 2. Layer ownership (unchanged from F1)

F2 owns Layer 1 (provider, via the `ai` SDK) and Layer 2 (engine), and enforces Layer 3 (safety)
using F1's contract. Layers 0 and 4 stay exactly as F1 defined them.

## 3. Package layout

| Package | Change | Holds |
|---|---|---|
| `@flowlet/agent` | **new** | The `ai` SDK engine, the guardrail policy, Composio ingestion, the `principal` shape, the error taxonomy. The only package with model/Composio dependencies. |
| `@flowlet/core` | **unchanged** | F1's contracts hold as shipped. No approval reversal, no new part. |
| `@flowlet/react` | **unchanged** | F1's `useFlowletChat` native-approval path works as-is against the real engine. |
| `examples/basic` | revise | Add an offline wiring of the real agent (mock model, an in-process tool, a sample policy) alongside the existing stub. |

Keeping the runtime in its own package is what makes "swappable behind `FlowletAgent`" real:
`@flowlet/core` never imports the engine.

## 4. Components

### 4.1 Engine — `createFlowletAgent(config): FlowletAgent`

`run(input)` builds the per-request toolset (4.3), runs the SDK loop, and returns the
`ReadableStream<UIMessageChunk>` F1 expects, using the same `createUIMessageStream` pattern the F1
stub uses:

- `input.messages` is the conversation history (multi-turn).
- `input.signal` is passed as the SDK `abortSignal`; cancellation propagates to the provider and
  to running tools, and is surfaced faithfully (4.6).
- `input.principal` is bound into the toolset closure (scopes Composio, feeds the policy).
- `input.tools` (caller-provided F1 tools) is merged per the precedence in 4.3.
- Run identity (`runId`, `threadId`, `schemaVersion`) rides as message metadata, exactly as F1 does.

Config carries the model, the persona instructions, the engine's own in-process tools, the Composio
settings, and the policy.

### 4.2 Persona

The agent system instructions: grounded in company context, well-informed, resistant to hijacking
and hallucination (per the product direction). Configuration, not new machinery.

### 4.3 Tool dispatch — sources, merge, and policy wrapping

The per-request toolset is the merge of four sources, each an `ai` SDK `ToolSet`:

1. **Caller tools** from `input.tools` (F1 contract; host-app tools).
2. **Engine in-process tools** from config, including the **`data-ui` render tool** that writes a
   `UINode` into the stream via the `createUIMessageStream` writer (the F1 stub's exact pattern).
3. **Composio tools, per user.** `composio.create(principal.userId).tools()` returns
   ai-SDK-format tools with managed OAuth and built-in execute, optionally filtered by an explicit
   toolkit/tool allowlist.
4. **Generic MCP tools** (optional, same shape) for non-Composio MCP servers.

**Precedence on name collision:** caller > engine > Composio > MCP. Collisions are logged.

**Every tool is wrapped by the policy (4.4) before it enters the toolset**, so the guardrail applies
uniformly regardless of source. Wrapping sets the SDK `needsApproval` callback and a fail-closed
`execute` guard; it preserves the tool's `inputSchema`, `annotations`, and original `execute`.

### 4.4 Guardrail engine (the novel IP) and how it maps to the SDK

A pluggable `ApprovalPolicy` produces a tri-state decision per call; the wrapper maps that decision
onto the SDK's native approval primitives. The decision is computed once per tool call and memoized
by tool call id, so the LLM-judge layer runs at most once per call.

```ts
type ApprovalDecision = "allow" | "approve" | "deny";
interface ApprovalPolicy {
  evaluate(ctx: { toolName: string; input: unknown; annotations?: ToolAnnotations;
                  principal: FlowletPrincipal }): ApprovalDecision | Promise<ApprovalDecision>;
}
```

Mapping onto the `ai` SDK:

- `allow` -> `needsApproval` returns `false`; the tool executes normally.
- `approve` -> `needsApproval` returns `true`; the SDK emits `tool-approval-request` and pauses;
  on approval the tool executes. This is F1's native path, unchanged.
- `deny` -> the wrapped `execute` fails closed with a `policy` `FlowletError` before the real tool
  runs, so the model sees a typed tool error and never reaches approval.

The policy is composed from small, independently testable layers, most-restrictive-wins:

- `annotationPolicy()` — default from MCP hints (`destructiveHint` or `openWorldHint` -> `approve`;
  `readOnlyHint` -> `allow`).
- `naturalLanguagePolicy(rules, judgeModel)` — the NL guardrail engine. Plain-English rules (for
  example "never send money over 500 without approval", "never delete production data") are
  evaluated by a fast LLM judge per candidate call, returning `allow`, `approve`, or `deny`.
- `rememberDecisions(policy, store)` — ask-once-remember, keyed by principal, tool, and scope.
  Backed by a pluggable `DecisionStore` (default in-memory, per-session). This is not a runtime
  storage dependency; it is an optional, injectable cache.
- Role and threshold checks read from `principal`.

**Scope boundary:** F2 owns the guardrail side (NL rules to approval decisions). NL automation
triggers ("when X happens, do Y") are F7.

### 4.5 `principal` — concrete shape

Fills F1's opaque `principal?: unknown` slot. Defined in `@flowlet/agent`:

```ts
interface FlowletPrincipal {
  userId: string;                    // scopes Composio connected accounts
  roles?: string[];                  // role-based policy
  limits?: Record<string, number>;   // numeric thresholds, e.g. { transferUsd: 500 }
}
```

It is bound into the toolset closure per request, so each tool's `execute` and the policy see the
same principal. No change to F1's `RunInput`, which already carries `principal?: unknown`.

### 4.6 Error taxonomy

A `FlowletError` carrying a typed `code`: `provider`, `tool`, `auth`, `policy`, `validation`,
`cancelled`, or `sandbox`. Tool-level errors surface as the SDK's tool-error path; loop-level
errors surface as the `error` stream part. Cancellation via `AbortSignal` is surfaced faithfully
to how the SDK represents an aborted run; the engine tags it `cancelled`.

## 5. Approval contract

Unchanged from F1. The request is the SDK's `tool-approval-request` part; the response is the
SDK's `addToolApprovalResponse({ id, approved })` from `useChat`, with auto-resubmit via
`lastAssistantMessageIsCompleteWithApprovalResponses`. Multiple pending approvals and correlation by
tool call id are handled by the SDK. There is no arg-editing on approval (the SDK approves or denies
the captured args); a future "edit then re-run" is a new tool call, not an approval mutation.

## 6. Data flow (one gated tool call)

1. Client sends; F1's transport calls `agent.run`; the engine runs the SDK loop with the
   policy-wrapped toolset.
2. The model emits a tool call. The wrapper evaluates the policy: `approve`. `needsApproval` returns
   `true`; the SDK emits `tool-approval-request`.
3. `useFlowletChat` surfaces it; the client renders a consent card; the user approves via
   `addToolApprovalResponse`; the SDK auto-resubmits.
4. The tool executes. If it is the render tool, it writes a `data-ui` node into the stream.
5. The client renders the node in the stage. The run finishes.

A `deny` decision short-circuits at step 2: the wrapped `execute` returns a `policy` error, the
model is informed, and nothing is asked of the user.

## 7. No storage dependency

Because approvals ride the SDK's stateless native flow (request out, response back in the next
turn's messages), F2 needs no run storage. The only stateful piece is the optional
`rememberDecisions` cache, which is injectable and defaults to in-memory.

## 8. Testing (pointed at contract risk, all offline)

All tests run against a mock model; no network, no storage.

- **Stream shape:** the engine emits a well-formed `ai` SDK v6 `UIMessage` stream including the
  `data-ui` part, with F1's metadata on `start`.
- **Policy mapping:** `allow` -> no approval and executes; `approve` -> `tool-approval-request`
  then executes on approval; `deny` -> fail-closed `policy` error, no approval, real tool never
  called.
- **Policy layers:** annotation default gates mutate and allows read; an NL rule (mock judge) gates
  a matching call; ask-once-remember suppresses the second prompt; a threshold gates over-limit
  args; most-restrictive-wins on composition.
- **Tool merge:** caller-provided F1 tool survives the merge and keeps working; collision precedence
  is correct.
- **Approval round-trip through F1's React seam:** request -> `addToolApprovalResponse` -> execute
  -> `data-ui`, via `useFlowletChat` unchanged.
- **Composio ingestion:** a mock Composio toolset maps cleanly into the toolset and is policy-wrapped;
  `principal.userId` reaches the Composio tool fetch; no network.
- **Cancellation:** `AbortSignal` aborts mid-stream and is surfaced as `cancelled`.

A separate, env-gated live smoke path exercises real Composio OAuth and tool execution; it is
skipped when keys are absent.

## 9. Risks and cons (honest)

1. **`ai` SDK coupling (inherited from F1, accepted).** F2 is coupled to the SDK's loop and
   approval primitives. F1 already chose this deliberately; F2 stays consistent. The `FlowletAgent`
   seam contains the blast radius if a different runtime is ever needed.
2. **LLM-judge guardrails add per-call latency and cost.** Only on candidate calls, only for the NL
   layer; deterministic layers short-circuit and the decision is memoized per call. Still a cost to
   watch; the judge model is configurable and defaults to a fast, cheap one.
3. **Deny semantics are a tool error, not a first-class refusal.** Mapping `deny` onto a fail-closed
   `execute` is correct and safe, but the model sees a tool error and may retry or rephrase. The
   persona instructions must teach it that policy denials are final.
4. **Composio breadth.** Broad tool discovery is a footgun. F2 starts with explicit toolkit/tool
   allowlists rather than importing everything.

## 10. Open questions

- The exact persona instructions and company-grounding strategy (F2 ships a sensible default; real
  grounding content is product-level, later).
- Whether the NL judge runs on the same model as the agent or a cheaper dedicated one (default: a
  fast dedicated judge model, configurable).
- Whether `rememberDecisions` needs cross-session persistence before F6; in-memory is the F2 default.

## 11. Env keys (for the live path only)

- `ANTHROPIC_API_KEY` — the agent model and the NL judge.
- `COMPOSIO_API_KEY` — Composio tool fetch, OAuth, and execution.

Both are required only for the env-gated live smoke path; the full test suite runs without them.
