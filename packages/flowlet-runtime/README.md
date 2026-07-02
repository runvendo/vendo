# @flowlet/runtime

Flowlet's portable agent runtime (architecture Decision 1): the model->tool
loop, tool calling, policy, UI generation, and the automations engine, plus
in-memory implementations of the five frozen seams for tests and embedded use.
It never imports a database, queue, or HTTP server (enforced by
`src/dependency-guard.test.ts`). Renamed from `@flowlet/agent` in the
2026-07-02 runtime carve-out.

Built on the Vercel `ai` SDK v6, it implements
F1's `FlowletAgent` interface with a real model->tool loop, per-user Composio
tool ingestion, and a pluggable guardrail policy. F1's `@flowlet/core` and
`@flowlet/react` are unchanged: approvals use the ai SDK's native
`needsApproval`/`addToolApprovalResponse` mechanism, not any custom protocol.

**Server-side only.** Composio tool ingestion uses Node.js internals; do not
include this package in a browser bundle.

## `createFlowletAgent(config)`

```ts
import { createFlowletAgent } from "@flowlet/runtime";

const agent = createFlowletAgent({
  model,           // LanguageModel (ai SDK) — required
  policy,          // ApprovalPolicy — required
  instructions,    // string system prompt (optional; a grounded default is used)
  tools,           // additional in-process ToolSet (optional)
  composio,        // { config: ComposioConfig; client?: ComposioClient } (optional)
  policyVersion,   // string mixed into decision-cache keys (optional)
  maxSteps,        // number, default 8
});
```

`agent.run(input)` returns the ai SDK `UIMessage` stream, including `data-ui`
parts for UI render events. Run identity (`runId`, `threadId`, `schemaVersion`)
is attached as metadata on the `start` chunk.

## Guardrail policy

Every tool call is evaluated by the configured `ApprovalPolicy` before
execution. The policy returns one of three decisions:

| Decision | Effect |
|----------|--------|
| `allow`  | Tool executes immediately, no pause. |
| `approve` | Tool is marked `needsApproval`; the ai SDK pauses the loop for human confirmation. |
| `deny`   | Tool `execute` returns a `policy_denied` payload; the loop continues fail-closed. |

### Composable layers

Combine layers with `composePolicy(...policies)`, which returns the most
restrictive decision across all layers (severity order: `allow < approve < deny`).

- `annotationPolicy` — decides based on `ToolDescriptor` annotations
  (e.g. `risk` level).
- `naturalLanguagePolicy` — LLM judge: sends tool name, input, and a prompt to
  a language model and returns its structured decision.
- `rememberDecisions` — wraps another policy and caches its decision for the
  lifetime of a run; each `approve` is asked at most once per tool per run.
- `roleRule` — allow/approve/deny based on the principal's `roles`.
- `thresholdRule` — allow/approve/deny based on numeric `limits` in the
  principal.

## Principal

```ts
interface FlowletPrincipal {
  userId: string;          // scopes Composio connected accounts
  roles?: string[];        // fed to roleRule
  limits?: Record<string, number>; // fed to thresholdRule
}
```

Pass `principal` on each `RunInput`. A missing or empty `userId` fails
Composio ingestion closed (no external tools are fetched).

## Composio

Per-user SaaS tools (Gmail, Slack, and so on) are ingested at the start of
each run via `ingestComposioTools`. The allowlist (`toolkits` or `tools`) is
mandatory: if both are empty, nothing is fetched.

```ts
composio: {
  config: {
    apiKey: process.env.COMPOSIO_API_KEY,
    toolkits: ["gmail", "slack"],   // fetched per-toolkit
    tools: ["GMAIL_SEND_EMAIL"],    // or specific slugs
  },
}
```

The real adapter wraps `@composio/core@0.4.0` + `@composio/vercel@0.4.0` and
calls `composio.tools.get(userId, { toolkits } | { tools })`. Because `toolkits`
and `tools` are mutually exclusive in a single call, the adapter issues one
request per non-empty dimension and merges the results.

Inject a `ComposioClient` in `composio.client` to swap in a fake for tests.

## Environment variables

| Variable | Required for |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Live model calls |
| `COMPOSIO_API_KEY` | Composio tool ingestion |

The full test suite (86 offline tests) runs without either key. The live
Composio integration test (`*.live.test.ts`) is skipped unless both keys are
present.
