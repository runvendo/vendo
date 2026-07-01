/**
 * Public API surface for `@flowlet/agent` — Flowlet's F2 agent runtime.
 */

export const FLOWLET_AGENT_PACKAGE = "@flowlet/agent";

// Engine
export { createFlowletAgent, RENDER_TOOL_NAME, RENDER_VIEW_TOOL_NAME } from "./engine";
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

// Descriptors
export { buildDescriptor } from "./descriptor";
export type { ToolDescriptor, ToolSource, ToolAnnotations } from "./descriptor";

// Toolset assembly
export { buildToolset } from "./toolset";
export type { ToolSourceInput } from "./toolset";

// Render tool
export { createRenderTool } from "./render-tool";

// Render view tool
export { createRenderViewTool } from "./render-view-tool";

// Composio ingestion
export {
  ingestComposioTools,
  createComposioClient,
} from "./composio";
export type { ComposioClient, ComposioConfig } from "./composio";
