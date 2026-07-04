/**
 * Public API surface for `@flowlet/runtime` — Flowlet's portable agent runtime
 * (architecture Decision 1: loop, tool calling, policy, UI generation,
 * automations; depends only on the five frozen seams + @flowlet/core).
 */

export const FLOWLET_RUNTIME_PACKAGE = "@flowlet/runtime";

// Engine
export { createFlowletAgent, RENDER_VIEW_TOOL_NAME, REQUEST_CONNECT_TOOL_NAME } from "./engine";
export type { FlowletAgentConfig } from "./engine";

// Principal
export type { FlowletPrincipal } from "./principal";

// Errors
export { FlowletError, policyDenied } from "./errors";
export type { FlowletErrorCode, PolicyDeniedPayload } from "./errors";

// Policy barrel (types, compose, annotation, natural-language, remember, principal-rules)
export * from "./policy";

// Tool wrapping
export { wrapTool } from "./wrap-tool";
export type { WrapToolArgs } from "./wrap-tool";
export { wrapClientTool } from "./wrap-client-tool";
export type { WrapClientToolArgs } from "./wrap-client-tool";

// Host-API tools (client-executed, ENG-202)
export { hostToolset, CLIENT_EXECUTOR_MARKER } from "./host-toolset";

// Descriptors
export { buildDescriptor } from "./descriptor";
export type { ToolDescriptor, ToolSource, ToolAnnotations, ToolExecutor } from "./descriptor";

// Toolset assembly
export { buildToolset } from "./toolset";
export type { ToolSourceInput } from "./toolset";

// Render view tool
export { createRenderViewTool } from "./render-view-tool";

// Brand guidance (data-driven system-prompt section from host theme tokens)
export { buildBrandGuidance } from "./brand-guidance";
export type { BrandGuidanceInput, HostBrandNorms } from "./brand-guidance";

// Generated-component compiler (JSX/TS → sandbox-ready ESM)
export { compileComponentSource } from "./compile-component";

// Request connect tool (host-privileged Connect card)
export { createRequestConnectTool } from "./request-connect-tool";

// Composio ingestion
export {
  ingestComposioTools,
  createComposioClient,
} from "./composio";
export type { ComposioClient, ComposioConfig } from "./composio";

// Automations engine (ENG-188): DSL, interpreter, store, runner, scheduler,
// ingest helpers, and chat authoring tools.
export * from "./automations";

// Embedded seam implementations (in-memory/in-process) for tests and
// embedded deployments — the other half of architecture Decision 1.
// InMemoryAutomationStore and InProcessScheduler already flow from the
// automations barrel above, so only the new embedded modules are listed.
export {
  createInMemoryStore,
  InMemoryAuditLog,
  InMemoryRemixStore,
  InMemorySavedFlowletStore,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./embedded/in-memory-store";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./embedded/in-process-credential-broker";
export { InProcessExecutor, type InProcessToolFn } from "./embedded/in-process-executor";
export {
  InAppChannels,
  type InAppChannelsConfig,
  type RetainedDelivery,
} from "./embedded/in-app-channels";
