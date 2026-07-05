/**
 * Public API surface for `@flowlet/next` — the batteries-included Next.js
 * adapter (App Router). One `createFlowletHandler()` collapses the chat,
 * action, integrations, capabilities and tick endpoints a host app would
 * otherwise hand-roll; the client half lives under `@flowlet/next/client`.
 *
 * Server-only: this entry reads `.flowlet/` from disk and holds API keys.
 * Import it from route handlers, never from a client component.
 */

export const FLOWLET_NEXT_PACKAGE = "@flowlet/next";

export { createFlowletHandler, type FlowletRouteHandlers } from "./handler";
export type { FlowletHandlerOptions, IntegrationCatalogEntry } from "@flowlet/server";
export { detectCapabilities, type FlowletCapabilities } from "@flowlet/server";
export { loadFlowletDir, type LoadedFlowletDir } from "@flowlet/server";
export { manifestToolsToHostTools } from "@flowlet/server";
export { defaultFlowletPolicy } from "@flowlet/server";
export { createConnectionsStore, type ConnectionsStore } from "@flowlet/server";
export { DEFAULT_INTEGRATION_CATALOG } from "@flowlet/server";
export { buildInstructions, type BuildInstructionsInput } from "@flowlet/server";
export {
  applyVerifiedPinBase,
  enrichAnchorSources,
  createSourceResolver,
  capSource,
  resolveRemixSealer,
} from "@flowlet/server";
// ENG-193 permissions surface — re-exported from @flowlet/server per the
// framework-agnostic split (the implementations live there now).
export { composeProductionPolicy, principalScope, EMBEDDED_TENANT } from "@flowlet/server";
export { createThreadIndex, type ThreadIndex } from "@flowlet/server";
export { handleConsentRoute, type ConsentRouteDeps } from "@flowlet/server";
export { listParkedActionsRoute, resolveParkedActionRoute } from "@flowlet/server";
