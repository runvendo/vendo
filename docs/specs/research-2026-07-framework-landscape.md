# Agent-Framework Landscape Research — July 2026

Reference doc for the @vendoai/core re-architecture: framework-neutral tool/module
contracts that integrate with (or duck-type as) each major framework's types.

Researched 2026-07-09. Version claims were checked against the npm registry, the
vercel/ai and openai/openai-agents-js sources at exact tags, and official spec repos —
not training-data memory. Our repo pins `ai@6.0.28` + `@ai-sdk/provider@3.0.2` +
`@standard-schema/spec@^1.1.0` (`packages/vendo-core/package.json`).

## TL;DR — the facts that change our design

1. **A plain object literal IS a valid Vercel AI SDK tool.** `tool()` is literally
   `function tool(tool: any): any { return tool; }` in both v6.0.28 and v7.0.19
   (verified from source). Our neutral tool objects can duck-type with zero imports.
2. **AI SDK 7 shipped 2026-06-25 and is npm `latest` (7.0.19).** v6 is still actively
   maintained on the `ai-v6` dist-tag (6.0.222 published 2026-07-09). Major cadence is
   ~6–7 months: v4 2024-11-18, v5 2025-07-31, v6 2025-12-22, v7 2026-06-25.
3. **Two zero-import schema paths exist for our neutral contracts:** (a) implement
   Standard Schema `~standard` (validate + the new `jsonSchema` converter from spec
   v1.1.0) — accepted by AI SDK, Mastra, and convertible everywhere; (b) the AI SDK's
   own `Schema` marker uses `Symbol.for('vercel.ai.schema')` — a *global* symbol
   registry, so third parties can construct a valid Schema without importing
   `@ai-sdk/provider-utils`.
4. **Raw JSON Schema works everywhere on our converter path:** AI SDK via
   `jsonSchema()`/symbol-marked object; OpenAI Agents SDK accepts JSON Schema
   `parameters` directly (parsed but not validated — we'd own validation); MCP tools
   are JSON Schema natively; Mastra accepts Standard-JSON-Schema-capable schemas.
5. **v7 deprecates per-tool `needsApproval`** (moves approval to
   `generateText`/`streamText`-level `toolApproval`) and renames tool-execute
   `experimental_context` → typed `context` via `contextSchema`. Our v6-shaped neutral
   tools remain valid in v7 (deprecated aliases retained), but the approval seam should
   not hard-couple to `needsApproval`.
6. **MCP Apps is real, ratified (Stable, 2026-01-26), and exactly the protocol we
   sketched:** extension id `io.modelcontextprotocol/ui`, predeclared `ui://` resources
   with `text/html;profile=mcp-app`, tools linked via `_meta.ui.resourceUri`,
   iframe↔host = MCP JSON-RPC over postMessage (`ui/initialize` handshake,
   `tools/call` from the UI, `ui/notifications/tool-result`, `ui/message`,
   `ui/update-model-context`), mandatory sandbox + host-constructed CSP, double-iframe
   sandbox proxy required for web hosts. Live in Claude (web+desktop), ChatGPT,
   VS Code Insiders, Goose.
7. **AI SDK 7 ships first-party MCP Apps client support** (`@ai-sdk/mcp` helpers +
   `experimental_MCPAppRenderer` in `@ai-sdk/react`) — building our module↔host UI
   protocol on MCP Apps means AI SDK hosts can render our modules with stock tooling.
8. **OpenAI Agents SDK JS is still 0.x** (0.13.1, 2026-07-09) with fast, breaking-ish
   cadence, but its HITL model (`interruptions` + serializable `RunState`) and JSON
   Schema tool path are stable enough to target via a converter.
9. **Mastra 1.50.1 straddles AI SDK v5/v6/v7 simultaneously** (bundles all three
   provider lines via npm aliases) and accepts any Standard-Schema library for
   `createTool` — our Standard Schema objects should flow in unchanged.
10. **MCP core spec current revision is 2025-11-25** (confirmed on the official
    versioning page today); OAuth 2.1 authorization, elicitation (incl. URL mode),
    experimental tasks, and the extensions mechanism (SEP-1724) that MCP Apps rides on
    are all in it.

---

## 1. Vercel AI SDK (`ai`)

### Versions and cadence

| Line | Version (2026-07-09) | dist-tag | First release |
|---|---|---|---|
| v7 | `ai@7.0.19`, `@ai-sdk/provider@4.0.3`, `provider-utils@5.0.7`, `@ai-sdk/react@4.0.20`, `@ai-sdk/mcp@2.0.10` | `latest` | 2026-06-25 |
| v6 (ours) | `ai@6.0.222`, `@ai-sdk/provider@3.0.14`, `provider-utils@4.0.38`, `@ai-sdk/mcp@1.0.61` | `ai-v6` | 2025-12-22 |
| v5 | `ai@5.0.210` | `ai-v5` | 2025-07-31 |

All three lines received publishes on 2026-07-09 — previous majors are actively
patched on dist-tags (no formal LTS statement found; UNVERIFIED how long that lasts).
License: Apache-2.0. Source: npm registry `time` fields.

### The `Tool` type at our pin (ai@6.0.28)

Verified from `packages/provider-utils/src/types/tool.ts` at tag `ai@6.0.28`:

```ts
type Tool<INPUT, OUTPUT> = {
  description?: string;
  title?: string;
  providerOptions?: ProviderOptions;
  inputSchema: FlexibleSchema<INPUT>;          // REQUIRED — the only required field
  inputExamples?: Array<{ input: INPUT }>;
  needsApproval?: boolean | ((input, { toolCallId, messages, experimental_context? }) => boolean | Promise<boolean>);
  strict?: boolean;                            // provider strict-mode hint
  onInputStart?; onInputDelta?; onInputAvailable?;
  toModelOutput?: ({ toolCallId, input, output }) => ToolResultOutput | Promise<...>;
}
// & execute XOR outputSchema (both optional when OUTPUT is never):
//   execute?: (input, { toolCallId, messages, abortSignal?, experimental_context? })
//     => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT> | OUTPUT
// & type?: 'function' (default) | 'dynamic' | 'provider' (provider needs id + args)
```

`ToolSet` (from `packages/ai/src/generate-text/tool-set.ts`) is just
`Record<string, Tool<...>>` with a `Pick` to keep callback types aligned — a plain
object map satisfies it.

**Duck-typing verdict: yes.** `tool()` and `dynamicTool()` are identity functions
(`dynamicTool` only adds `type: 'dynamic'`). There is no brand/symbol on the Tool
itself. A neutral object `{ description, inputSchema, execute, needsApproval }` is a
valid AI SDK tool as long as `inputSchema` is a valid `FlexibleSchema`.

### What `inputSchema` accepts (`FlexibleSchema`, verified from schema.ts)

```ts
type FlexibleSchema<T> =
  | Schema<T>                      // symbol-marked AI SDK schema
  | LazySchema<T>                  // () => Schema<T>
  | ZodSchema<T>                   // zod v3 or v4 types (special-cased)
  | StandardSchema<T>;             // StandardSchemaV1 & StandardJSONSchemaV1  ← both!
```

Conversion (`asSchema`): symbol-marked `Schema` passes through; anything with
`~standard` and `vendor === 'zod'` goes through the zod converters; **any other
`~standard` object must provide `~standard.jsonSchema.input({ target: 'draft-07' })`**
(v7 additionally injects `additionalProperties: false`). Raw JSON Schema is NOT
accepted bare — it must be wrapped, but the wrapper is trivial:

- `jsonSchema(schema, { validate? })` from `ai`/`@ai-sdk/provider-utils`, **or**
- construct it yourself without any import — the marker is a **registered global
  symbol**:

```ts
// Valid AI SDK Schema, zero @ai-sdk imports (verified against isSchema() in v6 & v7):
const s = {
  [Symbol.for('vercel.ai.schema')]: true,
  _type: undefined,            // type-inference carrier only
  jsonSchema: myJsonSchema7,   // may also be a Promise or handled lazily via getter
  validate: myValidateFn,      // key MUST exist ('validate' in obj), value may be undefined
};
```

`isSchema()` checks: object, `Symbol.for('vercel.ai.schema')] === true`,
`'jsonSchema' in value`, `'validate' in value`. This is stable across v6→v7.
Recommendation: prefer the Standard Schema route (portable) and treat the symbol
route as an AI-SDK-specific fast path; both avoid a hard dependency.

### v6 → v7 Tool changes (verified from source at ai@7.0.19 + migration guide)

- `Tool` becomes a discriminated union `FunctionTool | DynamicTool |
  ProviderDefinedTool | ProviderExecutedTool` (structurally compatible for the
  function case).
- Typed tool context: new `contextSchema?: FlexibleSchema<CONTEXT>`; execute options
  gain `context` (from per-tool `toolsContext`) replacing `experimental_context`;
  `experimental_sandbox?: SandboxSession` added.
- `metadata?: JSONObject` added; `description` may be a function of `{ context }`.
- `needsApproval` **@deprecated**: "Tool approval is handled on a `generateText` /
  `streamText` level now." `title` @deprecated in favor of `providerMetadata`.
- Platform: v7 is ESM-only, Node ≥22. Other renames (`system`→`instructions`,
  `onFinish`→`onEnd`, telemetry → `@ai-sdk/otel`) don't touch tool shape. Codemod:
  `npx @ai-sdk/codemod v7`. v6 names retained as deprecated aliases through v7.

### Approval / HITL (v6 semantics — what we pin)

- `needsApproval: true | (input, opts) => boolean` pauses execution; the UI stream
  emits `tool-approval-request`; tool part state becomes `approval-requested`.
- `useChat().addToolApprovalResponse({ id, approved, reason? })` answers it;
  `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`
  auto-resumes. Denied executions surface as `output-denied`.
- Docs: ai-sdk.dev/docs/agents/tool-approvals, /docs/ai-sdk-ui/chatbot-tool-usage.

### Dynamic tools & MCP

- `dynamicTool()` / `type: 'dynamic'` for runtime-defined tools (unknown types) —
  MCP tools arrive this way.
- `@ai-sdk/mcp` is the stable MCP client since v6 (v6 launch: "stable MCP support
  with OAuth"); v6 line at 1.0.61, v7 at 2.0.10.
- **v7 adds MCP Apps support**: `@ai-sdk/mcp` helpers to advertise the
  `io.modelcontextprotocol/ui` capability, `splitMCPAppTools()` to separate
  model-visible from app-only tools, `ui://` resource reading; `@ai-sdk/react`
  ships `experimental_MCPAppRenderer` (sandboxed iframe + JSON-RPC bridge,
  explicitly experimental). Docs: ai-sdk.dev/docs/ai-sdk-core/mcp-apps.

### UIMessage stream protocol

SSE with header `x-vercel-ai-ui-message-stream: v1`, terminated by `[DONE]`.
Chunk types (v7 docs): `start`/`finish`, `start-step`/`finish-step`,
`text-start/-delta/-end`, `reasoning-start/-delta/-end` (+ `reasoning-file`, new in
v7), `tool-input-start/-delta/-available`, `tool-output-available`,
`tool-output-denied`, `tool-approval-request/-response`, `source-url`,
`source-document`, `file`, `data-*` (custom data parts), `error`, `abort`, `custom`.
The `v1` header value has survived v5→v6→v7; part-type additions are additive, but
there is no written stability guarantee beyond the version header (UNVERIFIED policy).

---

## 2. OpenAI Agents SDK (JS/TS, `@openai/agents`)

- **Version/maturity:** 0.13.1 (published 2026-07-09) — still pre-1.0, releases every
  few days-to-weeks. MIT. `@openai/agents-core` deps: `openai@^6.46.0`; `zod@^4.0.0`
  is an *optional* peer. Node 20+, TS 5.4+.
- **Tool definition** (verified from `packages/agents-core/src/tool.ts` @ main):
  `tool({ name?, description, parameters, strict?, execute, errorFunction?,
  needsApproval?, isEnabled?, timeoutMs?, timeoutBehavior?, timeoutErrorFunction?,
  inputGuardrails?, outputGuardrails?, deferLoading?, customDataExtractor? })`.
  - `parameters`: a Zod **object** (`ZodObjectLike`, strict mode, auto-validated) or a
    **raw JSON Schema object** (`JsonObjectSchemaStrict` with `strict: true` default /
    `JsonObjectSchemaNonStrict` with `strict: false`) or `undefined` (arguments passed
    as raw string). **JSON Schema inputs are parsed as JSON but NOT validated** — our
    converter must attach its own validation.
  - Internal `FunctionTool` shape: `{ type: 'function', name, description,
    parameters: JsonObjectSchema, strict: boolean, invoke(runContext, input: string,
    details?), needsApproval: ToolApprovalFunction, isEnabled, ... }` — so
    **programmatic construction from JSON Schema descriptors is a first-class path**.
  - `execute(input, runContext)` where `RunContext<Context>` carries user context;
    approval fn signature is `(runContext, input, callId?) => Promise<boolean>`.
- **HITL:** `needsApproval: boolean | fn` → run pauses, `result.interruptions` holds
  `RunToolApprovalItem`s; resolve with `result.state.approve(i)` / `.reject(i)`
  (options `{ alwaysApprove | alwaysReject, message }`); resume by passing the state
  back to `run()`. `RunState` serializes via `toString()`/`fromString()` for
  long-lived approvals. Works with streaming (`stream.interruptions`). Same flow
  covers handoffs and nested `agent.asTool()`.
- **Handoffs & guardrails:** core primitives (`handoff()`, input/output guardrails at
  agent and tool level; v0.13 adds tool input/output guardrails + pre-approval input
  guardrails opt-in).
- **MCP:** three modes — `hostedMcpTool()` (server-side via OpenAI Responses API, with
  `requireApproval: 'always'|'never'|per-tool` + `onApproval` callback),
  `MCPServerStreamableHttp`, `MCPServerStdio` (`MCPServerSSE` deprecated).
- **Streaming:** `run(agent, input, { stream: true })` returns an AsyncIterable of
  three event kinds (raw model events, run-item events, agent-updated events) plus
  `toTextStream()` and `stream.completed` — a proprietary event model, not the AI SDK
  UI protocol.
- **Realtime/voice:** `RealtimeAgent`/`RealtimeSession` (WebRTC/WS); default realtime
  model is now `gpt-realtime-2`.

---

## 3. Mastra

- **Version:** `@mastra/core@1.50.1` (2026-07-06/07; 1.x GA since early 2026, weekly
  minors). Apache-2.0. `@mastra/mcp@1.13.1` (2026-07-06).
- **createTool** (docs: mastra.ai/reference/tools/create-tool):
  `createTool({ id, description, inputSchema, outputSchema?, suspendSchema?,
  resumeSchema?, execute(inputData, context) })`.
  - Schemas: "Standard JSON Schema" capable libraries — zod, valibot, arktype accepted
    (i.e. our Standard Schema objects with the `jsonSchema` converter fit).
  - `execute` second arg (`ToolExecutionContext`): `requestContext`, `abortSignal`,
    `agent`, `workflow` (suspend/resume lifecycle), `observe` (tracing/logging).
  - Tool-level `mcp` property carries MCP annotations (`title`, `readOnlyHint`,
    `destructiveHint`, `idempotentHint`, `openWorldHint`) + custom metadata — Mastra
    tools are designed to be served over MCP.
- **AI SDK relationship (verified from the published package.json):** `@mastra/core`
  bundles `@ai-sdk/provider` + `provider-utils` for **v5, v6, and v7 lines
  simultaneously** via npm aliases (`@ai-sdk/provider-v5/-v6/-v7`), plus
  `@standard-schema/spec@^1.1.0`, `zod ^3.25 || ^4`, `xstate` (workflows). Model I/O
  runs on AI SDK provider interfaces; any AI SDK provider package works.
- **Streaming:** native Mastra stream format, with adapters to the AI SDK UI protocol:
  `toAISdkStream()` / `handleChatStream()` / `format: 'aisdk'`, `version: 'v6'`
  option for AI SDK v6-typed apps; `@mastra/ai-sdk` package for useChat interop.
- **MCP:** `MCPClient` (multi-server, tool namespacing) and `MCPServer` (expose agents
  + tools as MCP) in `@mastra/mcp`.
- **Memory/storage:** `MastraStorage` + vector-store abstractions with many adapters
  (libsql default, pg, clickhouse, etc.); working/semantic memory on top. "OM"
  (observational memory) is an active 2026 workstream (per repo activity).
- **Third-party tool packages** integrate by exporting `createTool` results (or
  Vercel-AI-SDK-shaped tools, which Mastra agents also accept) — no registry
  mechanism beyond npm.

---

## 4. MCP + MCP Apps (critical for our module↔host UI protocol)

### Core spec

- **Current revision: 2025-11-25** (confirmed 2026-07-09 on
  modelcontextprotocol.io/specification/versioning; no newer ratified revision;
  drafts live under /specification/draft).
- 2025-11-25 highlights (official changelog): experimental **tasks** (SEP-1686,
  durable/polled long-running requests); **elicitation** upgrades — standards-based
  enums (SEP-1330), defaults (SEP-1034), **URL-mode elicitation** (SEP-1036); sampling
  gains `tools`/`toolChoice` (SEP-1577); icons metadata (SEP-973); tool-name guidance;
  JSON Schema 2020-12 as default dialect (SEP-1613); **extensions mechanism**
  (SEP-1724) — the hook MCP Apps uses.
- **Tool annotations** (`annotations.readOnlyHint/destructiveHint/idempotentHint/
  openWorldHint`, untrusted hints) — in the spec since 2025-03-26, unchanged in
  2025-11-25 (spec: /specification/2025-11-25/server/tools).
- **Authorization:** OAuth 2.1-based framework (since 2025-06-18). 2025-11-25 adds
  OIDC Discovery support, incremental scope consent via `WWW-Authenticate` (SEP-835),
  **Client ID Metadata Documents** as the recommended client-registration mechanism
  (SEP-991), and RFC 9728 protected-resource-metadata alignment (SEP-985). This is the
  contract for our "host-side OAuth" MCP door.
- SDK: `@modelcontextprotocol/sdk@1.29.0` (2026-03-30, MIT).

### MCP Apps (SEP-1865) — the actual spec

Source: `modelcontextprotocol/ext-apps` repo, `specification/2026-01-26/apps.mdx`.
**Status: Stable (2026-01-26).** Authors span Anthropic, OpenAI, and MCP-UI. Announced
2026-01-26 on the MCP blog; standardizes patterns from OpenAI Apps SDK + MCP-UI.

- **Extension identifier:** `io.modelcontextprotocol/ui`. Negotiated via the standard
  extensions capability: client sends
  `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes:
  ["text/html;profile=mcp-app"] }` in `initialize`. `ui://` prefix and the label are
  reserved in MCP.
- **UI resources:** predeclared MCP resources with `ui://` URIs and mimeType
  `text/html;profile=mcp-app`; content served via `resources/read` (`text` or base64
  `blob`), MUST be a valid HTML5 document. Resource `_meta.ui` carries: `csp`
  (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`),
  `permissions` (camera/microphone/geolocation/clipboardWrite), `domain` (dedicated
  sandbox origin, host-defined format — e.g. `{hash}.claudemcpcontent.com`,
  `www-example-com.oaiusercontent.com`), `prefersBorder`.
- **Tool↔UI linkage:** tool `_meta.ui = { resourceUri: "ui://…", visibility?:
  ["model","app"] }`. `visibility: ["app"]` = app-only tool: host MUST hide it from
  the model's tools/list and MUST reject app `tools/call` for tools lacking `"app"`;
  cross-server app calls always blocked. (Flat `_meta["ui/resourceUri"]` is deprecated,
  removal before GA.)
- **Iframe↔host protocol: MCP JSON-RPC over `postMessage`** — the iframe acts as an
  MCP client, the host as (proxying) server. No SDK required; raw example from the
  spec: `window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, '*')`,
  starting with `ui/initialize` (`protocolVersion: "2026-01-26"`, `appCapabilities`
  incl. `availableDisplayModes`) → result carries `hostCapabilities` (openLinks,
  serverTools, serverResources, logging, sandbox) + `hostContext` (theme, `styles.
  variables` — a standardized ~80-variable CSS custom-property vocabulary —
  `styles.css.fonts`, displayMode, containerDimensions fixed/max/unbounded, locale,
  timeZone, platform, deviceCapabilities, safeAreaInsets) → `ui/notifications/
  initialized`.
- **Standard MCP methods available to the view:** `tools/call`, `resources/read`,
  `notifications/message`, `ping`. **UI-specific:** view→host requests `ui/open-link`,
  `ui/message` (inject a user-role message into chat), `ui/request-display-mode`
  (inline|fullscreen|pip), `ui/update-model-context` (overwrite-style context for
  future turns); host→view `ui/notifications/tool-input` (required, once),
  `tool-input-partial` (streaming args, best-effort JSON repair), `tool-result`
  (`CallToolResult`), `tool-cancelled`, `ui/resource-teardown` (request/response —
  host SHOULD await before teardown), `ui/notifications/size-changed` (view→host,
  ResizeObserver-driven), `ui/notifications/host-context-changed` (partial updates).
- **Sandboxing:** iframe sandbox mandatory. Web hosts MUST use a **double-iframe
  sandbox proxy on a different origin** (`allow-scripts allow-same-origin`), with
  reserved `ui/notifications/sandbox-proxy-ready` / `sandbox-resource-ready`
  messages carrying the raw HTML + CSP config. Host MUST construct CSP from declared
  domains; restrictive default if none declared (`default-src 'none'; script-src
  'self' 'unsafe-inline'; …; connect-src 'none'`); MAY tighten, MUST NOT loosen.
- **Data conventions:** `content` = model-visible text, `structuredContent` =
  UI-render data (not model context), `_meta` = neither.
- **Explicitly deferred (not in MVP):** external URL embedding (`text/uri-list`),
  **state persistence/restoration**, multiple UI resources per tool, view↔view
  communication, custom sandbox policies. **No payload size limits are specified** in
  the spec.
- **Host support (blog, 2026-01-26):** Claude web + desktop, ChatGPT (same week),
  VS Code Insiders, Goose; JetBrains, AWS Kiro, Google Antigravity announced as
  coming. OpenAI commits to the standard; Apps SDK and MCP Apps **coexist** — the
  spec is the shared wire standard, not a merged SDK.
- **SDKs:** `@modelcontextprotocol/ext-apps@1.7.4` (2026-06-05, MIT) — `App` class
  for views, server helpers (`getUiCapability`, `RESOURCE_MIME_TYPE`), React hooks
  (`useHostStyleVariables`, `applyDocumentTheme`, auto `size-changed` via
  ResizeObserver). MCP-UI (`@mcp-ui/client@7.1.1`) predates the SEP and now tracks it.
  Plus AI SDK 7's client-side support (§1).

---

## 5. Standard Schema

- **Spec:** v1. `@standard-schema/spec@1.1.0` (npm, 2025-12-15; 1.0.0 was
  2025-01-27). Types-only package (also copy-pasteable — the spec encourages
  vendoring the interface, so implementing it requires **no runtime dependency**).
- **`~standard` interface** (verified from spec source):
  - `StandardSchemaV1.Props`: `version: 1`, `vendor: string`, `validate(value,
    options?) => Result | Promise<Result>`, `types?: { input, output }` (type-level
    only). `Result` = `{ value }` on success (`issues` falsy) or `{ issues:
    [{ message, path? }] }` on failure.
  - **New in 1.1.0:** `StandardTypedV1` (base) and **`StandardJSONSchemaV1`**:
    `~standard.jsonSchema: { input(options), output(options) }` where `options.target`
    ∈ `"draft-2020-12" | "draft-07" | "openapi-3.0" | string`; may throw for
    unsupported targets.
- **Implementers** (standardschema.dev): StandardSchemaV1 — zod ≥3.24, valibot ≥1.0,
  arktype ≥2.0, Effect Schema, yup, TypeBox adapters, many others.
  StandardJSONSchemaV1 — **zod v4.2+**, **ArkType v2.1.28+**, **Valibot v1.2+ (via
  `@valibot/to-json-schema` v1.5+)**, VineJS 4.3+, GraphQL Standard Schema 0.2+.
  Effect is NOT listed for the JSON Schema part.
- **Third-party implementation (our neutral tools):** attach
  `~standard: { version: 1, vendor: 'vendo', validate, jsonSchema: { input:
  ({target}) => ourJsonSchema, output: … } }` to a plain object. Because AI SDK's
  `asSchema` requires the `jsonSchema` converter for non-zod vendors (it calls
  `input({ target: 'draft-07' })`), we MUST implement StandardJSONSchemaV1, not just
  V1, for AI SDK compatibility. MCP Apps' own SDK types reference
  `StandardSchemaWithJSON` too — the ecosystem is converging on exactly this pair.
- Caveat: minimum AI SDK v6 patch that accepts non-zod Standard Schemas =
  our pinned 6.0.28 already does (verified in its source); the earliest 6.x with
  StandardJSONSchemaV1 support was not pinned down (UNVERIFIED, irrelevant at ≥6.0.28).

---

## 6. Cross-cutting comparison

| | Vercel AI SDK v6/v7 | OpenAI Agents JS 0.13 | Mastra 1.50 | MCP 2025-11-25 | LangChain/LangGraph JS |
|---|---|---|---|---|---|
| Tool input schema | `FlexibleSchema`: zod v3/v4, Standard Schema (V1+JSON), symbol-marked `Schema`, `jsonSchema()` wrapper | Zod v4 object (validated) OR raw JSON Schema (unvalidated) OR none | Standard-JSON-Schema libs (zod/valibot/arktype) | Raw JSON Schema (2020-12 default dialect) | zod primarily (JSON Schema accepted) |
| Execute signature | `(input, { toolCallId, messages, abortSignal, experimental_context→context })` | `(input, runContext)`; internal `invoke(runContext, rawJsonString)` | `(inputData, { requestContext, abortSignal, agent, workflow, observe })` | server-side handler per SDK; result = `content[] + structuredContent` | `(input, config)` |
| Approval / HITL | v6: per-tool `needsApproval` + `tool-approval-request` chunk + `addToolApprovalResponse`; v7: call-level `toolApproval` | `needsApproval` → `interruptions[]` + serializable `RunState.approve/reject` | tool `suspend()/resume()` + workflow suspend | elicitation (form + URL mode); MCP Apps `ui/message`; host-side approval UX | `interrupt()` in LangGraph |
| MCP client | `@ai-sdk/mcp` (stable, OAuth; v7 adds MCP Apps rendering) | hosted MCP tool + StreamableHTTP + stdio classes | `@mastra/mcp` MCPClient/MCPServer | — (is the protocol) | `@langchain/mcp-adapters` |
| Streaming protocol | UIMessage SSE, `x-vercel-ai-ui-message-stream: v1` | proprietary 3-kind event stream + `toTextStream()` | Mastra stream + `toAISdkStream()` adapters (v5/v6 targets) | JSON-RPC over Streamable HTTP (+ SSE polling) | LangGraph event/values streams |
| License | Apache-2.0 | MIT | Apache-2.0 | MIT (SDK); spec open | MIT |
| Cadence | major ~every 6–7 months; prior majors patched on dist-tags | 0.x, breaking minors, weekly-ish | weekly minors on 1.x | spec revision ~2/year (2025-03-26, -06-18, -11-25) | 1.x stable since late 2025 |
| 3rd-party tool package | export plain `Tool`-shaped objects / `ToolSet` maps | export `tool()` results or raw `FunctionTool` objects built from JSON Schema | export `createTool` results (or AI-SDK-shaped tools) | ship an MCP server | export `tool()` results |

**Implication for @vendoai/core:** a neutral tool = `{ name/description, JSON Schema,
execute, approval metadata, MCP annotations }` with a `~standard` (V1+JSON) schema
object converts losslessly to all five targets; AI SDK needs no conversion at all.

## 7. Other load-bearing findings

- **AI SDK 7 extras relevant to us:** `WorkflowAgent` (durable, resumable runs that
  survive restarts/approval delays), `HarnessAgent` (wrap external agent frameworks
  behind the AI SDK `Agent` interface — a potential adapter seam for Vendo modules),
  first-class `SandboxSession`, TUI for agent dev, `@ai-sdk/otel` telemetry.
- **v7 approval relocation** (tool-level `needsApproval` → call-level `toolApproval`)
  means approval policy is trending toward the *host/orchestrator*, not the tool —
  matches our host-owned-consent architecture; keep approval as tool *metadata* that
  hosts enforce.
- **OpenAI Apps SDK vs MCP Apps:** did not merge into one SDK; MCP Apps is the shared
  wire standard both commit to. Building on MCP Apps covers ChatGPT + Claude + VS Code.
- **OpenAI Agents Python/JS divergence:** both maintained; JS remains 0.x while Python
  is the older line; feature sets track each other loosely (JS-only: some voice
  features first). Not a blocker for a converter targeting the JS tool shape.
  (Divergence details UNVERIFIED beyond version numbers.)
- **LangGraph JS (deliberately deprioritized):** `@langchain/core@1.2.2` (MIT).
  `tool(fn, { name, description, schema })` with zod (`.describe()` for field docs);
  agents via `createAgent({ model, tools })`, executed through `ToolNode`, results as
  `ToolMessage`. Nothing here changes our contract design; a thin converter suffices.
- **A2A:** agent↔agent interop (peer protocol), orthogonal to tool/module contracts;
  Mastra is experimenting with an A2A agent class (visible in `@mastra/core`
  dist-tags). No action for core contracts now. (Status beyond that UNVERIFIED.)
- **Zod in our core:** we pin `zod@^3.24.0`. zod 3.24 implements StandardSchemaV1 but
  the StandardJSONSchemaV1 converter is **zod v4.2+ only** — if we keep emitting
  Standard Schema objects ourselves this doesn't matter, but if we ever pass raw zod 3
  schemas across the seam, AI SDK special-cases them while other consumers may not.

## Sources

- vercel/ai source at tags `ai@6.0.28` and `ai@7.0.19`:
  `packages/provider-utils/src/types/tool.ts`, `packages/provider-utils/src/schema.ts`,
  `packages/ai/src/generate-text/tool-set.ts` (raw.githubusercontent.com)
- npm registry metadata (versions/dates/licenses): registry.npmjs.org for `ai`,
  `@ai-sdk/*`, `@openai/agents(-core)`, `@mastra/core`, `@mastra/mcp`,
  `@standard-schema/spec`, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`,
  `@mcp-ui/client`, `@langchain/core` (queried 2026-07-09)
- AI SDK 7: https://vercel.com/blog/ai-sdk-7 ·
  https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0 ·
  https://ai-sdk.dev/docs/ai-sdk-core/mcp-apps ·
  https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol ·
  https://ai-sdk.dev/docs/agents/tool-approvals
- AI SDK 6: https://vercel.com/blog/ai-sdk-6
- OpenAI Agents JS: https://github.com/openai/openai-agents-js
  (`packages/agents-core/src/tool.ts`, docs `guides/human-in-the-loop.mdx`,
  `guides/mcp.mdx`, `guides/streaming.mdx`) · https://openai.github.io/openai-agents-js/
- Mastra: https://mastra.ai/reference/tools/create-tool ·
  https://mastra.ai/reference/ai-sdk/to-ai-sdk-stream · published
  `@mastra/core@1.50.1` package.json
- MCP: https://modelcontextprotocol.io/specification/versioning ·
  https://modelcontextprotocol.io/specification/2025-11-25/changelog ·
  https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP Apps: https://github.com/modelcontextprotocol/ext-apps
  (`specification/2026-01-26/apps.mdx`, SEP-1865) ·
  https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/ ·
  https://apps.extensions.modelcontextprotocol.io/
- Standard Schema: https://standardschema.dev/ · https://standardschema.dev/json-schema ·
  spec source `packages/spec/src/index.ts` (github.com/standard-schema/standard-schema)
- LangChain JS: https://docs.langchain.com/oss/javascript/langchain/tools
