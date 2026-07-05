/**
 * Public API surface for `@flowlet/server` — the framework-agnostic handler
 * core behind `@flowlet/next`. This package holds the request handlers
 * (chat/action/integrations), capability detection, `.flowlet/` loading,
 * the embedded automations world, the default policy, and the agent/
 * instructions builder. Framework adapters (like `@flowlet/next`) wire
 * these into their routing layer; this package has no framework deps.
 *
 * Server-only: reads `.flowlet/` from disk and holds API keys. Never import
 * this from a client component.
 */

export const FLOWLET_SERVER_PACKAGE = "@flowlet/server";

export { handleChat, type ChatDeps } from "./chat";
export { handleAction, createApprovalStore, type ActionDeps, type ApprovalStore } from "./action";
export {
  DEFAULT_INTEGRATION_CATALOG,
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
  type ConnectionsStore,
  type IntegrationsDeps,
} from "./integrations";
export {
  detectCapabilities,
  type FlowletCapabilities,
  type DetectCapabilitiesOptions,
} from "./capabilities";
export { loadFlowletDir, type LoadedFlowletDir } from "./flowlet-dir";
export { manifestToolsToHostTools } from "./manifest-tools";
export { buildInstructions, createAgentCache, type BuildInstructionsInput, type AgentFactoryConfig } from "./agent";
export { createAutomationsWorld, type FlowletAutomationsWorld, type CreateWorldConfig } from "./world";
export {
  resolveModel,
  resolveModelChoice,
  type ModelChoice,
  type ModelProvider,
  type ResolveModelDeps,
} from "./model";
export { defaultFlowletPolicy } from "./default-policy";
export { resolvePrincipal, DEFAULT_PRINCIPAL, type GuardResult } from "./guard";
export { parseHandlerOptions, type FlowletHandlerOptions, type IntegrationCatalogEntry } from "./options";
export { createFlowletFetchHandler, type FlowletFetchHandler } from "./fetch-handler";
export { toNodeHandler, type FetchHandler, type NodeHandler } from "./node";
export {
  applyVerifiedPinBase,
  enrichAnchorSources,
  createSourceResolver,
  capSource,
} from "./remix-enrich";
export { resolveRemixSealer } from "./seal";
export { resolveMcpServers, mcpJsonSchema, mcpServerArraySchema } from "./mcp-config";
