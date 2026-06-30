# Flowlet F2 — Agent Core + Composio Integrations (Design)

- **Issue:** ENG-176 (F2 · Agent core + Composio integrations)
- **Date:** 2026-06-30
- **Status:** Designed, approved. Builds on F1 (ENG-174), which is implemented and green.
- **Blocked by:** F1. **Blocks:** D2 (ENG-178).
- **F1 design reference:** `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`

## 0. What F2 is

F2 turns F1's stub into a real agent. F1 shipped the contracts (`FlowletAgent`, the `ai` SDK
`UIMessage` stream, the `data-ui` part, the registry) and a scripted stub that drives the loop
with a mock model. F2 ships the production runtime behind the same `FlowletAgent` interface:
a real LLM loop, per-user external tools via Composio, and Flowlet's guardrail engine.

No demo-specific content. This builds Flowlet itself.

## 1. Locked decisions (from brainstorming)

1. **Runtime is Mastra, behind `FlowletAgent`.** F2's engine is a Mastra `Agent`. The
   `FlowletAgent` seam keeps the runtime swappable, but F2 commits to Mastra now, betting that
   its durable workflows and memory pay off for later layers (F6 memory, F7 automations).
   Mastra reuses the `ai` SDK at the streaming edge, so F1's `UIMessage` protocol holds.
2. **Mastra-native approvals.** Mastra owns the loop, so F2 adopts Mastra's approval model:
   the `requireToolApproval` policy function plus storage-backed suspend/resume. This reverses
   F1's "SDK-native HITL, no custom approval contract" decision. Accepted trade-off: F2 takes a
   storage dependency and reintroduces a small `data-approval` part. Upside: resumable approvals
   survive refresh, serverless, and resumed runs (the robustness F1's section 5.5 wanted), and
   they are the right substrate for F7 automations.
3. **Guardrails: LLM judge plus deterministic layers.** Natural-language rules are evaluated by
   a fast LLM judge per candidate call; annotation, role, and threshold layers stay
   deterministic. Most-restrictive layer wins.
4. **Composio: full ingestion plus live OAuth.** Real per-user tool fetch, managed OAuth connect
   flow, and tool execution. Tests run offline against a mock toolset; the live path is gated
   behind env keys.
5. **Provider-agnostic, Anthropic-first.** The model is swappable; the default is Anthropic
   (Opus). Provider choice never leaks into the public contract.

## 2. Layer ownership (unchanged from F1)

F2 owns Layer 1 (provider, via the `ai` SDK under Mastra) and Layer 2 (engine), and enforces
Layer 3 (safety) using F1's contract. Layers 0 and 4 stay as F1 defined them.

## 3. Package layout

| Package | Change | Holds |
|---|---|---|
| `@flowlet/agent` | **new** | The Mastra engine, the guardrail policy, Composio ingestion, the `principal` shape, the error taxonomy. All heavy deps (Mastra, Composio, Anthropic) live here. |
| `@flowlet/core` | revise | Reintroduce the `data-approval` part contract (request + response shapes). Stays dependency-light; no Mastra or Composio. |
| `@flowlet/react` | revise | Transport gains a resume channel; `useFlowletChat` gains `respondToApproval`; consumes `data-approval`. |
| `examples/basic` | revise | Add an offline wiring of the real agent (mock model, in-memory storage, an in-process tool) alongside the existing stub. |

Keeping the runtime in its own package is what makes "swappable behind `FlowletAgent`" real:
`@flowlet/core` never imports Mastra.

## 4. Components

### 4.1 Engine — `createFlowletAgent(config): FlowletAgent`

Wraps a Mastra `Agent`. `run(input)` maps F1's `RunInput` onto Mastra and converts the output
back to F1's stream:

- `input.messages` drives `agent.stream`.
- `input.signal` becomes Mastra's `abortSignal` (cancellation propagates to provider and tools).
- `input.principal` populates Mastra's `RuntimeContext` (scopes Composio, feeds the policy).
- The guardrail policy is passed as `requireToolApproval`.
- Output goes through `toAISdkStream(stream, { version: "v6" })`, wrapped in
  `createUIMessageStream`, producing the `ReadableStream<UIMessageChunk>` F1 already returns.

Config carries the model, the persona instructions, the in-process tools, the Composio settings,
the policy, and the storage adapter.

### 4.2 Persona

The Mastra agent `instructions`: grounded in company context, well-informed, resistant to
hijacking and hallucination (per the product direction). This is configuration, not new
machinery.

### 4.3 Tool dispatch — three sources, one toolset

The agent's toolset merges:

- **In-process Flowlet tools** (`ai` SDK `tool()`), including the `data-ui` render tool that
  emits UI nodes into the stream.
- **Composio tools, per user.** `composio.create(principal.userId).tools()` returns
  ai-SDK-format tools with managed OAuth and built-in execute. Optionally filtered by toolkit.
- **MCP tools** via the same ingestion path (Composio is F2's focus; generic MCP is the same
  shape).

### 4.4 Guardrail engine (the novel IP)

A pluggable `ApprovalPolicy` feeding `requireToolApproval`. Decisions are `allow`, `approve`, or
`deny`. Built from small, independently testable layers, composed most-restrictive-wins:

- `annotationPolicy()` — default from MCP hints (`destructiveHint` or `openWorldHint` gate;
  `readOnlyHint` allows).
- `naturalLanguagePolicy(rules, judgeModel)` — the NL guardrail engine. Plain-English rules
  (for example "never send money over 500 without approval", "never delete production data")
  are evaluated by a fast LLM judge per candidate call, returning allow / approve / deny.
- `rememberDecisions(policy, storage)` — ask-once-remember, keyed by principal, tool, and scope.
- Role and threshold checks read from `principal`.

Illustrative shape (not final code):

```ts
type ApprovalDecision = "allow" | "approve" | "deny";
interface ApprovalPolicy {
  evaluate(ctx: { toolName: string; args: unknown; principal: FlowletPrincipal }):
    ApprovalDecision | Promise<ApprovalDecision>;
}
```

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

### 4.6 Error taxonomy

A `FlowletError` carrying a typed `code`: `provider`, `tool`, `auth`, `policy`, `validation`,
`cancelled`, or `sandbox`. Surfaced as the `ai` SDK `error` stream part. `AbortSignal` maps to
`cancelled`.

## 5. Approval contract (reintroduced in `@flowlet/core`)

```ts
type ApprovalRequest  = { runId: string; toolCallId: string; toolName: string;
                          prompt: string; input: unknown; expiresAt?: number }; // as data-approval
type ApprovalResponse = { runId: string; approved: boolean; editedInput?: unknown };
```

The request rides out as a `data-approval` part. The response rides back as a transport resume
call, not an imperative side method on the agent.

## 6. Data flow (one gated tool call)

1. Client sends; the transport calls `agent.run`; Mastra streams with `requireToolApproval` set
   to the policy.
2. The model emits a tool call. `policy.evaluate` returns `approve`. Mastra suspends and persists
   the run to storage.
3. The engine emits a `data-approval` part `{ runId, toolCallId, toolName, args, prompt }`. The
   client renders a consent card.
4. The user approves, optionally editing args. The client calls
   `transport.resumeApproval({ runId, approved, editedInput })`. Mastra resumes; the tool runs.
5. The render tool emits a `data-ui` node via `writer.custom`. The client renders it in the
   stage. The run finishes.

## 7. Storage

A swappable storage adapter (Mastra's), needed only because suspend/resume persists runs.
Default is **LibSQL in-memory** (zero external dependency, offline, used in dev and tests).
Production swaps to LibSQL-file or Postgres.

## 8. Testing (pointed at contract risk, all offline)

All tests run against a mock model and in-memory storage; no network.

- **Stream shape:** the engine emits a well-formed `ai` SDK v6 `UIMessage` stream including the
  `data-ui` part.
- **Policy layers:** annotation default gates mutate and allows read; an NL rule gates a matching
  call; ask-once-remember suppresses the second prompt; a threshold gates over-limit args.
- **Approval round-trip:** suspend to `data-approval` to resume to tool execution to `data-ui`.
- **Composio ingestion:** a mock Composio toolset maps cleanly into the agent toolset; no network.
- **Cancellation:** `AbortSignal` aborts mid-stream and yields a `cancelled` error part.
- **Principal scoping:** `principal.userId` reaches the Composio tool fetch.

A separate, env-gated live smoke path exercises real Composio OAuth and tool execution; it is
skipped when keys are absent.

## 9. Risks and cons (honest)

1. **Reverses an F1 approval decision.** F1 chose the SDK-native, stateless HITL and deleted its
   custom approval contract; F2 reintroduces a `data-approval` part and a storage dependency.
   Accepted because Mastra owns the loop and its resumable approvals are better for F7.
2. **Storage is now on the critical path.** Even the simplest gated call needs storage to
   suspend. Mitigated by an in-memory default, but the dependency is real.
3. **LLM-judge guardrails add per-call latency and cost.** Only on candidate calls, and only for
   the NL layer; deterministic layers short-circuit. Still a cost to watch.
4. **Mastra coupling.** F2 is now coupled to Mastra's loop, approval, and storage APIs. The
   `FlowletAgent` seam contains the blast radius, but a runtime swap later is real work.

## 10. Open questions

- The exact persona instructions and company-grounding strategy (F2 ships a sensible default;
  real grounding content is product-level, later).
- Whether the NL judge runs on the same model as the agent or a cheaper dedicated one
  (default: a fast dedicated judge model, configurable).
- Production storage choice (LibSQL-file vs Postgres) is a deployment decision for D2.

## 11. Env keys (for the live path only)

- `ANTHROPIC_API_KEY` — the agent model and the NL judge.
- `COMPOSIO_API_KEY` — Composio tool fetch, OAuth, and execution.

Both are required only for the env-gated live smoke path; the full test suite runs without them.
