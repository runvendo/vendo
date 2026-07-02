/**
 * Public API surface for `@flowlet/agent` — Flowlet's F2 agent runtime.
 */

export const FLOWLET_AGENT_PACKAGE = "@flowlet/agent";

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
