/**
 * Public API surface for `@vendoai/server` — the framework-agnostic handler
 * core behind `createVendoHandler` (the `{ GET, POST }` route pair for
 * file-router catch-alls) and `toNodeHandler` (Express/`node:http`). This
 * package holds the request handlers (chat/action/integrations), capability
 * detection, `.vendo/` loading, the embedded automations world, the default
 * policy, and the agent/instructions builder. This is the internal
 * `@vendoai/server` package, surfaced publicly via the `vendoai` umbrella's
 * `vendoai/server` subpath; it has no framework deps.
 *
 * Server-only: reads `.vendo/` from disk and holds API keys. Never import
 * this from a client component.
 */

export const VENDO_SERVER_PACKAGE = "@vendoai/server";

export { handleChat, type ChatDeps } from "./chat.js";
export { handleAction, createApprovalStore, type ActionDeps, type ApprovalStore } from "./action.js";
export {
  DEFAULT_INTEGRATION_CATALOG,
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
  type ConnectionsStore,
  type IntegrationsDeps,
} from "./integrations.js";
export {
  detectCapabilities,
  type VendoCapabilities,
  type EnvCapabilities,
  type DetectCapabilitiesOptions,
} from "./capabilities.js";
export { loadVendoDir, type LoadedVendoDir } from "./vendo-dir.js";
export { manifestToolsToHostTools } from "./manifest-tools.js";
export { buildInstructions, createAgentCache, type BuildInstructionsInput, type AgentFactoryConfig } from "./agent.js";
export { createAutomationsWorld, type VendoAutomationsWorld, type CreateWorldConfig } from "./world.js";
export {
  resolveModel,
  resolveModelChoice,
  type ModelChoice,
  type ModelProvider,
  type ResolveModelDeps,
} from "./model.js";
export { defaultVendoPolicy } from "./default-policy.js";
export { resolvePrincipal, tickServiceAuth, threadScope, DEFAULT_PRINCIPAL, WORLD_SCOPE, type GuardResult } from "./guard.js";
export { parseHandlerOptions, type VendoHandlerOptions, type IntegrationCatalogEntry } from "./options.js";
export {
  createVendoFetchHandler,
  ingestVendoEvent,
  routeTail,
  ensureVendoState,
  bootRegistry,
  resetVendoBootRegistry,
  type IngestVendoEventOptions,
  type IngestVendoEventResult,
  type VendoFetchHandler,
  type VendoState,
} from "./fetch-handler.js";
export { createVendoHandler, type VendoRouteHandlers } from "./route-handler.js";
export { startVendoScheduler } from "./boot.js";
export {
  createDrizzleVendoRegistry,
  createInMemoryVendoRegistry,
  handleVendosGet,
  handleVendosPost,
  type VendoRegistry,
} from "./vendos.js";
export { toNodeHandler, type FetchHandler, type NodeHandler } from "./node.js";
export {
  applyVerifiedPinBase,
  enrichAnchorSources,
  createSourceResolver,
  capSource,
} from "./remix-enrich.js";
export { resolveRemixSealer } from "./seal.js";
export { resolveMcpServers, mcpJsonSchema, mcpServerArraySchema } from "./mcp-config.js";

// ENG-193 permissions system: production policy stack, thread index, and the
// consent/fade/trust/parked-action route handlers behind the fetch handler's
// endpoints — exported so hosts and adapters can mount them directly.
export { composeProductionPolicy, principalScope, EMBEDDED_TENANT } from "./policy-stack.js";
export { createThreadIndex, type ThreadIndex } from "./threads.js";
export { handleConsentRoute, type ConsentRouteDeps } from "./consent.js";
export { handleFadeProposalRoute, type FadeProposalRouteDeps } from "./fade-proposal.js";
export { handleVoiceSessionPost, type VoiceSessionDeps } from "./voice.js";
export { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions.js";
export {
  listGrantsRoute,
  revokeGrantRoute,
  listRulesRoute,
  revokeRuleRoute,
  queryAuditRoute,
  listCriticalToolsRoute,
} from "./trust.js";
