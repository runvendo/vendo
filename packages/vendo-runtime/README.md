# @vendoai/runtime

The server-side runtime that powers the composed Vendo host experience. It provides the model-to-tool loop, policy enforcement, generated views, integration ingestion, and the automations engine used by `@vendoai/server` and custom hosts. It does not import a database, queue, or HTTP server.

Do not include this package in a browser bundle. Composio and MCP ingestion use server-side capabilities.

## `createVendoAgent(config)`

```ts
import { createVendoAgent } from "@vendoai/runtime";

const agent = createVendoAgent({
  model,        // AI SDK LanguageModel
  policy,       // ApprovalPolicy applied to every tool
  instructions, // string or per-run instruction builder
  tools,        // host-supplied server tools
  controlTools, // Vendo steering or automation control tools
  components,   // registered components accepted by render_view
  composio,     // optional Composio ingestion
  mcp,          // optional host-declared MCP servers
  maxSteps,     // defaults to 8
  onSettled,    // optional full-message persistence hook
});
```

`agent.run(input)` returns an AI SDK `UIMessage` stream. UI render events use typed `data-ui` parts, and run identity is attached to the stream metadata.

## Generated views

The built-in `render_view` tool accepts a complete `GeneratedPayload`, validates the node graph and host component props, compiles generated component source, and streams the resulting view. `createRequestConnectTool` emits the host-rendered connection affordance used for integration OAuth.

## Policy

Every tool call is evaluated by an `ApprovalPolicy` before execution:

| Decision | Effect |
|---|---|
| `allow` | Execute immediately. |
| `approve` | Pause for human confirmation through the AI SDK approval flow. |
| `deny` | Return a fail-closed policy error without executing the tool. |

The package exports policy composition, annotation policy, natural-language policy, principal rules, permission-grant matching, compiled rules, audit hooks, breakers, and fade-shape helpers.

## Principal and integrations

Each run receives a `VendoPrincipal` with a required `userId` and optional `roles` and `limits`. The user id scopes connected accounts. Composio ingestion requires an explicit toolkit or tool allowlist. MCP ingestion uses only the host-declared server list. Both paths support injected clients or sources for offline tests.

## Automations

The automations barrel exports the DSL schema, expressions, interpreter, principal-scoped engine store, runner, in-process scheduler, host-event ingest helpers, and control tools. Hosts decide which authoring tools to expose.

## Embedded implementations

For tests and in-process hosts, the package provides in-memory thread, automation, audit, grant, rule, and decision stores, plus an in-process credential broker, executor, scheduler, and in-app channels implementation. Durable persistence belongs in `@vendoai/store` or a host-provided seam implementation.
