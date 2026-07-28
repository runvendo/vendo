/** @vendoai/actions — every API becomes agent tools (docs/contracts/04-actions.md). */
export * from "./formats.js";
// Tool identity + the judgment layer's deterministic half. Both are at the
// ROOT, not behind the node-only ./sync entry: the runtime registry applies
// judgments, and writing one means computing bindingIdentity.
export * from "./binding-identity.js";
export * from "./judgments.js";
export * from "./host-semantics.js";
export * from "./connectors/connector.js";
export { composioConnector } from "./connectors/composio.js";
// Consumed by @vendoai/vendo's cloudTools, which mirrors the BYO connector's
// naming + curated risk so both postures behave identically.
export { composioToolRisk } from "./connectors/composio-risk.js";
export { normalizeToolName } from "./connectors/names.js";
export { mcpConnector, type McpAuthContext, type McpHeadersResolver } from "./connectors/mcp.js";
export { createActions, type ActionsRegistry, type ActionsRunContext, type ServerActionHandler } from "./runtime/registry.js";
export { createConnectGate, type ConnectGate, type ConnectGateOptions } from "./runtime/connect-gate.js";
export { type ToolSearchMatch, type ToolSearchOptions } from "./runtime/search.js";
export { validateCapabilities, type CapabilityIssue, type PrimitiveStepTarget } from "./runtime/compound.js";
// Build-/dev-time extraction surface moved to `@vendoai/actions/sync` so the
// runtime entry stays portable (no node:fs / TypeScript compiler in server
// bundles). See src/sync/public.ts.
