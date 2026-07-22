/** @vendoai/actions — every API becomes agent tools (docs/contracts/04-actions.md). */
export * from "./formats.js";
export * from "./connectors/connector.js";
export { composioConnector } from "./connectors/composio.js";
// Consumed by @vendoai/vendo's cloudTools, which mirrors the BYO connector's
// naming + curated risk so both postures behave identically.
export { composioToolRisk } from "./connectors/composio-risk.js";
export { normalizeToolName } from "./connectors/names.js";
export { mcpConnector, type McpAuthContext, type McpHeadersResolver } from "./connectors/mcp.js";
export { createActions, type ActionsRegistry, type ActionsRunContext, type ServerActionHandler } from "./runtime/registry.js";
export { type ToolSearchMatch, type ToolSearchOptions } from "./runtime/search.js";
export { validateCapabilities, type CapabilityIssue, type PrimitiveStepTarget } from "./runtime/compound.js";
// Build-/dev-time extraction surface moved to `@vendoai/actions/sync` so the
// runtime entry stays portable (no node:fs / TypeScript compiler in server
// bundles). See src/sync/public.ts.
