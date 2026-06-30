# Flowlet F2 — Agent Core + Composio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@flowlet/agent`, the real Flowlet agent runtime, on the `ai` SDK v6 behind F1's `FlowletAgent` interface: a tool-calling loop, a pluggable guardrail policy, and per-user Composio tools, emitting F1's `UIMessage` stream unchanged.

**Architecture:** A new dependency-heavy package implements `FlowletAgent`. Its `run()` builds a per-request toolset (caller + engine + Composio + MCP), wraps every tool with the guardrail policy, runs `streamText` inside `createUIMessageStream` (mirroring F1's working `stub-agent.ts`), and returns a `ReadableStream<UIMessageChunk>`. Approvals stay on the SDK's native HITL, so `@flowlet/core` and `@flowlet/react` do not change. `execute` is the authoritative fail-closed policy gate.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, `ai@6.0.28` (pinned to match F1), `@ai-sdk/anthropic`, `@ai-sdk/mcp`, `@ai-sdk/provider` + `ai/test` (mock model), `@composio/core`, `@composio/vercel`, Zod.

**Spec:** `docs/superpowers/specs/2026-06-30-flowlet-f2-agent-core-design.md`. Read it before starting.

**Ground rules for the implementer:**
- TDD throughout: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Mirror `packages/flowlet-core/src/stub-agent.ts` for all `streamText` / `createUIMessageStream` / `data-ui` / metadata patterns. It compiles and passes on `ai@6.0.28`; do not improvise the stream shape.
- All unit/integration tests run offline against `MockLanguageModelV3` (from `ai/test`) and injected fakes. No network, no API keys, no storage.
- Dependency-inject external clients (the Composio client, the judge model) so they can be faked in tests.
- Keep files small and single-purpose per the file map below.
- Commit after every green task.

---

## File map (`packages/flowlet-agent/`)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Package scaffold; deps pinned to match F1. |
| `src/principal.ts` | `FlowletPrincipal` type. |
| `src/errors.ts` | `FlowletError` class + typed `code` union; `policy_denied` payload shape. |
| `src/descriptor.ts` | `ToolDescriptor` type + `buildDescriptor()` capturing annotations from a tool's MCP `_meta` / source. |
| `src/policy/types.ts` | `ApprovalPolicy`, `ApprovalDecision`, the policy eval context. |
| `src/policy/compose.ts` | `composePolicy()` most-restrictive-wins. |
| `src/policy/annotation.ts` | `annotationPolicy()` from descriptor annotations. |
| `src/policy/natural-language.ts` | `naturalLanguagePolicy(rules, judgeModel)` LLM-judge layer, fail-closed. |
| `src/policy/remember.ts` | `DecisionStore` interface + in-memory impl + `rememberDecisions()` wrapper. |
| `src/policy/principal-rules.ts` | `roleRule()`, `thresholdRule()` reading `principal`. |
| `src/policy/index.ts` | Barrel for the policy layers. |
| `src/wrap-tool.ts` | `wrapTool()` — the authoritative `needsApproval` + `execute` gate; field preservation; no-`execute` handling. |
| `src/render-tool.ts` | `createRenderTool(writer)` emitting a `data-ui` `UINode` (F1 stub pattern). |
| `src/composio.ts` | `ingestComposioTools(principal, config, clientFactory)` → toolset + descriptors; allowlist; fail-closed. |
| `src/toolset.ts` | `buildToolset()` — merge sources with precedence, wrap all. |
| `src/engine.ts` | `createFlowletAgent(config)` → `FlowletAgent`. |
| `src/index.ts` | Public exports. |
| `src/*.test.ts` | Co-located tests per unit. |

Also modified: `examples/basic/` (offline real-agent wiring), root `turbo`/workspace already globs `packages/*`.

---

## Task 1: Scaffold the `@flowlet/agent` package

**Files:**
- Create: `packages/flowlet-agent/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts` (empty export)

- [ ] **Step 1:** Copy the `package.json` / `tsconfig.json` / `vitest.config.ts` shape from `packages/flowlet-core`. Name `@flowlet/agent`. Add dependencies: `@flowlet/core` (workspace:*), `ai` and `@ai-sdk/provider` pinned to the exact versions in `flowlet-core/package.json`, plus `@ai-sdk/anthropic`, `@ai-sdk/mcp`, `@composio/core`, `@composio/vercel`, `zod`. Dev deps: `vitest`, `typescript`. Pin exact versions for the `ai`/`@ai-sdk/*` line to match F1; for Composio, install the newest versions that the repo's npm date-gate allows and pin them exactly (record the resolved versions in the PR).
- [ ] **Step 2:** Add a placeholder export to `src/index.ts` so the package type-checks.
- [ ] **Step 3:** Run `pnpm install` at the root, then `pnpm -F @flowlet/agent typecheck`. Expected: passes.
- [ ] **Step 4:** Commit: `chore(agent): scaffold @flowlet/agent package`.

## Task 2: `principal.ts` and `errors.ts`

**Files:**
- Create: `src/principal.ts`, `src/errors.ts`, `src/errors.test.ts`

- [ ] **Step 1 (test):** Assert `FlowletError` carries a typed `code` from the union (`provider | tool | auth | policy | validation | cancelled | sandbox`), preserves `message`, and exposes a `policyDenied(toolName, rule)` helper that returns the structured `policy_denied` payload (a plain serializable object with `code: "policy_denied"`, `tool`, `rule`).
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `FlowletPrincipal` (`userId: string; roles?: string[]; limits?: Record<string, number>`) and `FlowletError` + the `policyDenied` helper.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): principal shape and error taxonomy`.

## Task 3: `descriptor.ts`

**Files:**
- Create: `src/descriptor.ts`, `src/descriptor.test.ts`

- [ ] **Step 1 (test):** Given (a) a tool whose MCP `_meta` carries annotation hints (`readOnlyHint`/`destructiveHint`/`openWorldHint`) and (b) a plain `ai` SDK tool with none, assert `buildDescriptor(name, tool, source)` returns `{ name, source, annotations, hasExecute, kind }` with annotations extracted from `_meta` for the first and an empty annotations object for the second, and `hasExecute` true/false reflecting presence of `execute`. Note in the test why this exists: the `ai` SDK `Tool` type has no `annotations` field, so Flowlet captures hints into the descriptor at ingestion.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `ToolDescriptor` + `buildDescriptor()`. Read annotations from MCP `_meta` and any Composio-provided metadata; default to `{}` when absent.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): tool descriptor side table`.

## Task 4: Policy types and composition

**Files:**
- Create: `src/policy/types.ts`, `src/policy/compose.ts`, `src/policy/compose.test.ts`

- [ ] **Step 1 (test):** Assert `composePolicy(a, b, …)` returns the most-restrictive decision across layers, with ordering `allow < approve < deny`. Cover: all-allow → allow; one approve → approve; one deny → deny (even if others allow); async layers awaited.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `ApprovalDecision`, `ApprovalPolicy` (eval context = `{ toolName, input, descriptor, principal }`), and `composePolicy()`.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): approval policy types and most-restrictive composition`.

## Task 5: `annotationPolicy()`

**Files:**
- Create: `src/policy/annotation.ts`, `src/policy/annotation.test.ts`

- [ ] **Step 1 (test):** Assert: `readOnlyHint` → `allow`; `destructiveHint` or `openWorldHint` → `approve`; no/unknown hints → `approve` (fail-safe). Reads from `descriptor.annotations`, not the tool.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `annotationPolicy()`.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): annotation policy layer`.

## Task 6: `naturalLanguagePolicy()` (LLM judge)

**Files:**
- Create: `src/policy/natural-language.ts`, `src/policy/natural-language.test.ts`

- [ ] **Step 1 (test):** Using a `MockLanguageModelV3` judge, assert: a call matching a rule yields the rule's decision (`approve`/`deny`); a non-matching call yields `allow`; a judge that throws yields `deny` (fail-closed). The judge is invoked with the rules + tool name + input and returns a structured decision (use the SDK's structured-output path; mirror how the codebase calls the model).
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `naturalLanguagePolicy(rules, judgeModel)`. Wrap the judge call in try/catch that returns `deny` on any error.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): natural-language guardrail judge layer`.

## Task 7: `rememberDecisions()` + `DecisionStore`

**Files:**
- Create: `src/policy/remember.ts`, `src/policy/remember.test.ts`

- [ ] **Step 1 (test):** Assert that after a first `approve` decision is recorded for a canonical key `(principal.userId, toolName, args-digest, policyVersion)`, a second identical call returns `allow` (ask-once-remember), while a different key still consults the inner policy. Use the default in-memory `DecisionStore`. Assert the store is injectable.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `DecisionStore` interface, an in-memory implementation, the canonical-key digest, and `rememberDecisions(policy, store)`.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): ask-once-remember decision layer`.

## Task 8: `principal-rules.ts` (role + threshold)

**Files:**
- Create: `src/policy/principal-rules.ts`, `src/policy/principal-rules.test.ts`, `src/policy/index.ts`

- [ ] **Step 1 (test):** `thresholdRule({ argPath, limitKey })`: when the numeric arg exceeds `principal.limits[limitKey]` → `approve`, otherwise `allow`. `roleRule({ requiredRole })`: when `principal.roles` lacks the role → `deny`, otherwise `allow`.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement both rules; add `src/policy/index.ts` barrel re-exporting all layers + `composePolicy`.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): role and threshold policy rules`.

## Task 9: `wrapTool()` — the correctness core

**Files:**
- Create: `src/wrap-tool.ts`, `src/wrap-tool.test.ts`

Read spec §4.4 carefully before this task. Key facts: `needsApproval` is an args-only async predicate with no `toolCallId`; `execute` runs in a later turn after approval and is the authoritative gate; do not rely on a memo bridging the two callbacks.

- [ ] **Step 1 (tests):** Cover, each as its own assertion:
  - **allow** → `needsApproval` false; original `execute` runs and returns its result.
  - **approve** → `needsApproval` true; after the SDK would approve, `execute` runs the original.
  - **deny** → `needsApproval` false; `execute` returns the structured `policy_denied` payload and the original `execute` is never called.
  - **execute is authoritative across the turn** → build a *fresh* wrapped instance (no shared memo) for the would-be resubmit; a `deny` evaluated only at `execute` time still blocks, and an `approve`/`allow` still runs.
  - **field preservation** → the wrapped tool keeps `inputSchema`, `outputSchema`, `title`, `providerOptions`, `toModelOutput`, and any extra fields; only `needsApproval` and `execute` differ.
  - **no-`execute` tool** → wrapping a tool without `execute` is approval-gated only; a policy that returns `deny` for it causes `wrapTool` to throw at registration with a clear message.
  - **judge cache** → with the natural-language layer, two identical inputs evaluate the judge once; a cold key evaluates fresh and a forced judge error yields `deny`.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `wrapTool(name, tool, descriptor, policy, principal, judgeCache)`: shallow-clone preserving all fields; set `needsApproval` to evaluate the policy and return true only for `approve`; set `execute` to re-evaluate (using the canonical-key cache for the judge), return `policy_denied` on `deny`, otherwise call the bound original `execute` forwarding `ToolExecutionOptions` (including `abortSignal`); refuse to register a no-`execute` tool that a policy denies.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): policy-wrapping tool gate (execute authoritative)`.

## Task 10: `render-tool.ts`

**Files:**
- Create: `src/render-tool.ts`, `src/render-tool.test.ts`

- [ ] **Step 1 (test):** Assert that executing the tool returned by `createRenderTool(writer)` writes a `data-ui` chunk carrying a `UINode` (matching F1's `data-ui` part shape) to the provided writer and returns a confirmation. Mirror the `renderDemoCard` pattern in `flowlet-core/src/stub-agent.ts`.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `createRenderTool(writer)`.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): data-ui render tool`.

## Task 11: `composio.ts`

**Files:**
- Create: `src/composio.ts`, `src/composio.test.ts`

- [ ] **Step 1 (test):** With an injected fake Composio client factory, assert `ingestComposioTools(principal, config, factory)`: constructs the client via the factory, fetches tools scoped to `principal.userId` filtered by the config allowlist (`toolkits`/`tools`), returns an `ai` SDK toolset plus a `ToolDescriptor` per tool, and **fails closed** (returns an empty toolset, no client call) when `principal.userId` is missing or the allowlist is empty. No network.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `ingestComposioTools()` using `@composio/core` + `@composio/vercel` (`new Composio({ provider: new VercelProvider() })`, `await composio.create(userId)`, `await session.tools(allowlist)`), behind the injectable factory so tests never hit the network. Build descriptors from returned tool metadata.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): per-user Composio tool ingestion with mandatory allowlist`.

## Task 12: `toolset.ts`

**Files:**
- Create: `src/toolset.ts`, `src/toolset.test.ts`

- [ ] **Step 1 (test):** Assert `buildToolset()` merges caller / engine / Composio / MCP sources with precedence caller > engine > Composio > MCP (later sources do not overwrite earlier names), wraps every resulting tool via `wrapTool`, logs collisions, and that a caller-provided F1 tool survives the merge and is wrapped. Use fakes for Composio/MCP.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `buildToolset()` building descriptors per source, applying precedence, and wrapping each tool.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): toolset merge with precedence and uniform policy wrapping`.

## Task 13: `engine.ts` — `createFlowletAgent()`

**Files:**
- Create: `src/engine.ts`, `src/engine.test.ts`

Mirror `flowlet-core/src/stub-agent.ts` for the `createUIMessageStream` + `streamText` + metadata structure; the only differences are a real (here mocked) model, the built toolset, and the render tool bound to the writer.

- [ ] **Step 1 (tests):** With a `MockLanguageModelV3`:
  - **stream shape** → `run(input)` returns a `ReadableStream<UIMessageChunk>` that is a well-formed `ai` SDK v6 `UIMessage` stream, carries F1's metadata (`runId`/`threadId`/`schemaVersion`) on `start`, and includes a `data-ui` part when the render tool runs.
  - **approval flow** → a model tool call gated to `approve` emits `tool-approval-request`; after an approval response in the next turn's messages, `execute` runs and emits `data-ui`.
  - **cancellation** → aborting `input.signal` mid-stream surfaces the SDK's native `abort` chunk (assert the stream ends via abort, not a custom part).
  - **principal scoping** → the configured Composio ingestion receives `input.principal.userId` (assert via the injected fake).
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Implement `createFlowletAgent(config)` returning `{ run }`. `run` opens `createUIMessageStream`, builds the toolset (caller `input.tools` + engine tools + render tool + Composio via the injected factory), runs `streamText` with the model, `abortSignal: input.signal`, and `stopWhen`, and merges its UI stream with F1's metadata callback.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `feat(agent): createFlowletAgent engine on ai SDK v6`.

## Task 14: Public exports + React-seam integration test

**Files:**
- Modify: `src/index.ts`
- Create: `examples/basic/src/realAgent.ts`, `examples/basic/src/realAgent.test.tsx` (or co-located integration test)

- [ ] **Step 1 (test):** Mount `FlowletProvider` (from `@flowlet/react`, unchanged) with the real agent (mock model, in-memory everything), a registered `DemoCard`, and a policy that gates the render tool to `approve`. Drive the full loop through `useFlowletChat`: send a message → assert `tool-approval-request` surfaces → call `addToolApprovalResponse({ id, approved: true })` → assert auto-resubmit runs `execute` → assert the `data-ui` node arrives and resolves in the registry. This proves F1's React seam is genuinely unchanged.
- [ ] **Step 2:** Run; expect fail.
- [ ] **Step 3:** Export the public surface from `src/index.ts` (`createFlowletAgent`, `FlowletPrincipal`, `FlowletError`, the policy layers + `composePolicy`, `DecisionStore`). Wire `examples/basic/src/realAgent.ts`.
- [ ] **Step 4:** Run; expect pass.
- [ ] **Step 5:** Commit: `test(agent): React-seam approval round-trip against real engine`.

## Task 15: Offline example wiring

**Files:**
- Modify: `examples/basic/src/App.tsx`, `examples/basic/src/components.tsx`

- [ ] **Step 1:** Add a toggle/section in the example that runs the real agent (mock model) with one in-process tool and a sample composed policy (annotation + one natural-language rule with a mock judge), alongside the existing stub. No network.
- [ ] **Step 2:** Run `pnpm -F basic typecheck` (and the example's build). Expected: passes.
- [ ] **Step 3:** Commit: `docs(example): offline real-agent wiring alongside stub`.

## Task 16: Env-gated live Composio smoke test

**Files:**
- Create: `src/composio.live.test.ts`

- [ ] **Step 1:** Write a test that is skipped unless `COMPOSIO_API_KEY` and `ANTHROPIC_API_KEY` are set. When set, it constructs the real Composio client, ingests a single allowlisted read-only toolkit scoped to a test `userId`, and asserts at least one tool comes back with managed execution. Use Vitest's skip-when-env-absent pattern.
- [ ] **Step 2:** Run the full suite without keys; expect this test SKIPPED and everything else green.
- [ ] **Step 3:** Commit: `test(agent): env-gated live Composio smoke path`.

## Task 17: Final verification + README

**Files:**
- Create: `packages/flowlet-agent/README.md`

- [ ] **Step 1:** Write a short README: what `@flowlet/agent` is, `createFlowletAgent` usage, the policy layers, the `principal` shape, and the env-gated live path. No code beyond a minimal usage outline if your repo convention allows; otherwise prose only.
- [ ] **Step 2:** Run `pnpm typecheck && pnpm build && pnpm test` at the root. Expected: all green across `flowlet-core`, `flowlet-react`, `flowlet-agent`, `examples/basic`, with the live test skipped.
- [ ] **Step 3:** Commit: `docs(agent): README and F2 green across workspace`.

---

## Self-review notes (coverage check against the spec)

- Spec §4.1 engine → Task 13. §4.2 persona → carried as `config.instructions` in Task 13 (no separate machinery, per spec). §4.3 sources/merge/descriptor/wrapping → Tasks 3, 9, 11, 12. §4.4 policy + layers + mapping → Tasks 4–9. §4.5 principal → Task 2. §4.6 errors/deny/cancellation → Tasks 2, 9, 13. §5 approval contract (native, unchanged) → Tasks 13, 14. §6 data flow → Tasks 13, 14. §7 no storage → satisfied by construction (no storage task). §8 tests → distributed across all tasks; the wrapper and React-seam tests (Tasks 9, 14) carry the highest-risk coverage. §11 env keys → Task 16.
- Persona note: the spec leaves exact instructions as an open question; Task 13 wires `config.instructions` with a sensible default and does not over-build grounding (F6 concern).
