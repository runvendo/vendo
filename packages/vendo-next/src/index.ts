/**
 * Public API surface for `@vendoai/next` — the batteries-included Next.js
 * adapter (App Router). One `createVendoHandler()` collapses the chat,
 * action, integrations, capabilities and tick endpoints a host app would
 * otherwise hand-roll; the client half lives under `@vendoai/next/client`.
 *
 * Server-only: this entry reads `.vendo/` from disk and holds API keys.
 * Import it from route handlers, never from a client component.
 */

export const VENDO_NEXT_PACKAGE = "@vendoai/next";

export { createVendoHandler, type VendoRouteHandlers } from "./handler";
export { startVendoScheduler } from "@vendoai/server";
export type { VendoHandlerOptions, IntegrationCatalogEntry } from "@vendoai/server";
export { detectCapabilities, type VendoCapabilities } from "@vendoai/server";
export { loadVendoDir, type LoadedVendoDir } from "@vendoai/server";
export { manifestToolsToHostTools } from "@vendoai/server";
export { defaultVendoPolicy } from "@vendoai/server";
export { createConnectionsStore, type ConnectionsStore } from "@vendoai/server";
export { DEFAULT_INTEGRATION_CATALOG } from "@vendoai/server";
export { buildInstructions, type BuildInstructionsInput } from "@vendoai/server";
export {
  applyVerifiedPinBase,
  enrichAnchorSources,
  createSourceResolver,
  capSource,
  resolveRemixSealer,
} from "@vendoai/server";
// ENG-193 permissions surface — re-exported from @vendoai/server per the
// framework-agnostic split (the implementations live there now).
export { composeProductionPolicy, principalScope, EMBEDDED_TENANT } from "@vendoai/server";
export { createThreadIndex, type ThreadIndex } from "@vendoai/server";
export { handleConsentRoute, type ConsentRouteDeps } from "@vendoai/server";
export { listParkedActionsRoute, resolveParkedActionRoute } from "@vendoai/server";
