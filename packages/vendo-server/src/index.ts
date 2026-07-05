/**
 * Public API surface for `@vendoai/server` — the framework-agnostic handler
 * core behind `@vendoai/next`. This package holds the request handlers
 * (chat/action/integrations), capability detection, `.vendo/` loading,
 * the embedded automations world, the default policy, and the agent/
 * instructions builder. Framework adapters (like `@vendoai/next`) wire
 * these into their routing layer; this package has no framework deps.
 *
 * Server-only: reads `.vendo/` from disk and holds API keys. Never import
 * this from a client component.
 */

export const VENDO_SERVER_PACKAGE = "@vendoai/server";

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
  type VendoCapabilities,
  type EnvCapabilities,
  type DetectCapabilitiesOptions,
} from "./capabilities";
export { loadVendoDir, type LoadedVendoDir } from "./vendo-dir";
export { manifestToolsToHostTools } from "./manifest-tools";
export { buildInstructions, createAgentCache, type BuildInstructionsInput, type AgentFactoryConfig } from "./agent";
export { createAutomationsWorld, type VendoAutomationsWorld, type CreateWorldConfig } from "./world";
export {
  resolveModel,
  resolveModelChoice,
  type ModelChoice,
  type ModelProvider,
  type ResolveModelDeps,
} from "./model";
export { defaultVendoPolicy } from "./default-policy";
export { resolvePrincipal, tickServiceAuth, threadScope, DEFAULT_PRINCIPAL, WORLD_SCOPE, type GuardResult } from "./guard";
export { parseHandlerOptions, type VendoHandlerOptions, type IntegrationCatalogEntry } from "./options";
export {
  createVendoFetchHandler,
  routeTail,
  ensureVendoState,
  bootRegistry,
  resetVendoBootRegistry,
  type VendoFetchHandler,
  type VendoState,
} from "./fetch-handler";
export { startVendoScheduler } from "./boot";
export {
  createDrizzleVendoRegistry,
  createInMemoryVendoRegistry,
  handleVendosGet,
  handleVendosPost,
  type VendoRegistry,
} from "./vendos";
export { toNodeHandler, type FetchHandler, type NodeHandler } from "./node";
export {
  applyVerifiedPinBase,
  enrichAnchorSources,
  createSourceResolver,
  capSource,
} from "./remix-enrich";
export { resolveRemixSealer } from "./seal";
export { resolveMcpServers, mcpJsonSchema, mcpServerArraySchema } from "./mcp-config";

// ENG-193 permissions system: production policy stack, thread index, and the
// consent/fade/trust/parked-action route handlers behind the fetch handler's
// endpoints — exported so hosts and adapters can mount them directly.
export { composeProductionPolicy, principalScope, EMBEDDED_TENANT } from "./policy-stack";
export { createThreadIndex, type ThreadIndex } from "./threads";
export { handleConsentRoute, type ConsentRouteDeps } from "./consent";
export { handleFadeProposalRoute, type FadeProposalRouteDeps } from "./fade-proposal";
export { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions";
export {
  listGrantsRoute,
  revokeGrantRoute,
  listRulesRoute,
  revokeRuleRoute,
  queryAuditRoute,
  listCriticalToolsRoute,
} from "./trust";
