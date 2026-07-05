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
export type { FlowletHandlerOptions, IntegrationCatalogEntry } from "./options";
export { detectCapabilities, type FlowletCapabilities } from "./capabilities";
export { loadFlowletDir, type LoadedFlowletDir } from "./flowlet-dir";
export { manifestToolsToHostTools } from "./manifest-tools";
export { defaultFlowletPolicy } from "./default-policy";
export { createConnectionsStore, type ConnectionsStore } from "./connections";
export { DEFAULT_INTEGRATION_CATALOG } from "./catalog";
export { buildInstructions, type BuildInstructionsInput } from "./agent";
export {
  applyVerifiedPinBase,
  enrichAnchorSources,
  createSourceResolver,
  capSource,
} from "./remix-enrich";
export { resolveRemixSealer } from "./seal";
