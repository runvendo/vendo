# ENG-202 (embedded half): Host API as the agent's tools — act as the user

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent calls the host company's own REST API as the signed-in user: an OpenAPI spec becomes policy-governed agent tools, mutating calls are gated behind the existing approval cards, and approved calls execute in the user's browser on their existing session (topology B). Proven live in demo-bank.

**Architecture (locked; per ENG-202 + platform architecture Decisions 2 & 4):**
Tool descriptors are derived host-agnostically from an OpenAPI spec, with mutating/dangerous annotations. Server-side, the tools are registered with no execute body and flow through the existing policy layer, which gates them via the ai SDK's native approval mechanism (existing approval cards). Client-side, a new executor in the React SDK performs the actual fetch against the host API with the user's session, and returns the result into the chat turn (ai SDK client-tool path). User credentials never leave the browser; the loop only sees tool results.

**Verified SDK semantics (ai 6.0.28, probed empirically — these drive the design):**
- The tool-call chunk reaches the client *before* the approval-request chunk, so the client executor must key off settled tool-part state after the stream finishes, never off `onToolCall`.
- A denied approval is synthesized into an "execution denied" tool result by the SDK itself — decline needs no new code or UI.
- An approved client tool produces a broken model prompt if resubmitted without an output, so auto-resubmission must wait for the client executor's result. This requires a host-aware send predicate in the provider.
- A policy `deny` on a client-executed tool cannot be short-circuited server-side (there is no execute to intercept); it is enforced fail-closed by erroring the turn. Unreachable with today's annotation policy (which only yields allow/approve), noted in the findings.

**Decisions:**
- The OpenAPI adapter and the browser-side call executor live in `@flowlet/core` (pure, isomorphic, contract-level). The server-side toolset builder and client-tool policy wrapper live in `@flowlet/agent` (additive files only — a parallel contracts session owns broader refactors). The React glue (executor wiring + send predicate) lives in `@flowlet/react`. No new packages; no changes to the locked package layout.
- Host tools enter the engine through the existing, so-far-unexercised **caller tools seam** (`RunInput.tools`) — no engine changes. Client-executed tools are marked on the tool object; the toolset builder routes them to an approval-only wrapper instead of failing closed on missing execute.
- Annotations: GET/HEAD → read-only (auto-allowed); POST/PUT/PATCH → mutating (approval-gated by the existing fail-safe); DELETE and `x-flowlet-dangerous: true` → destructive (approval-gated explicitly). A spec author can override per-operation via `x-flowlet-*` extensions.
- demo-bank gets a real OpenAPI 3.1 spec for its existing API (all read routes + its one write, `POST /api/orders`); a test asserts the spec stays in sync with the actual route files. The demo policy routes caller-source tools through the annotation policy (its name-verb heuristic doesn't fit camelCase operationIds).
- No new UI: existing ApprovalCard + activity chips already render any tool's approval and result states.

---

## Tasks

### Task 1: OpenAPI → host tool definitions adapter (`@flowlet/core`)
- [ ] TDD `openApiToHostTools`: operations become definitions with name (operationId, sanitized), description, a flat JSON-Schema input (path/query params top-level, request body under `body`), HTTP call metadata (method, path template, param locations), and annotations per the method/extension rules above.
- [ ] TDD `executeHostToolCall`: pure fetch-based executor — builds the URL from path/query params, sends the body, includes credentials, returns `{ status, ok, data }` (structured HTTP errors are data for the model; only network failures throw).
- [ ] Export from the package index. Commit.

### Task 2: Client-executed tools in the agent runtime (`@flowlet/agent`, additive)
- [ ] TDD `hostToolset`: definitions → ai SDK ToolSet entries with no execute, embedded annotations, and a client-executor marker.
- [ ] TDD `wrapClientTool`: approval-only policy wrapper — allow → no approval, approve → approval requested, deny → fail-closed error; refuses tools that carry an execute.
- [ ] TDD descriptor + toolset routing: descriptors capture the executor marker; `buildToolset` sends marked no-execute tools through `wrapClientTool`, everything else unchanged (existing fail-closed skip preserved).
- [ ] Export new bits from the index. Full package test suite green. Commit.

### Task 3: Browser executor + send predicate (`@flowlet/react`)
- [ ] TDD the pure decision helpers: which settled host-tool parts are ready to execute (un-gated and finished streaming, or approved), and a host-aware `sendAutomaticallyWhen` that preserves today's behavior when no host tools are involved but holds resubmission until approved host tools have outputs.
- [ ] Wire into `FlowletProvider` via an optional `hostTools` config: an internal executor component watches the shared chat, executes ready calls once each via `executeHostToolCall`, and feeds results back with `addToolOutput`.
- [ ] Full package suite green. Commit.

### Task 4: demo-bank — OpenAPI spec + wiring (testbed only)
- [ ] Author `apps/demo-bank/openapi.json` covering the existing API surface (accounts, transactions, cards, payees, goals, profile, notifications, scheduled payments, insights, and `POST /api/orders` as the gated mutating action), inline schemas, camelCase operationIds.
- [ ] Test: every spec path+method corresponds to an actual route file (keeps the spec honest in CI).
- [ ] Shared module derives host tool definitions from the spec; chat route passes them through the caller seam; `FlowletRoot` passes them to the provider's `hostTools`.
- [ ] Demo policy: caller-source tools are decided by the annotation policy; all other sources keep the existing name-verb heuristic.
- [ ] Suite + typecheck + lint green across the workspace. Commit.

### Task 5: Live end-to-end in demo-bank + evidence
- [ ] Run the demo; in a real browser ask the agent for a read (auto-allowed, no card) and for a late-night order (approval card appears; approve; order executes **from the browser** — verified via the network log; new transaction visible in the app).
- [ ] Screenshots of the approval card and the executed result for the PR.
- [ ] Decline path: decline a second order; agent acknowledges without executing.

### Task 6: Findings note, PR
- [ ] Short findings note in `docs/superpowers/specs/` (SDK semantics discovered, deny-on-client-tool caveat, what the cloud port will need).
- [ ] Push branch `yousef/eng-202-their-apiclimcp-as-the-agents-tools-act-as-the-user`, open PR (never merge), update worktree comment.
