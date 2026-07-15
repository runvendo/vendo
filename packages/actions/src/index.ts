/** @vendoai/actions — every API becomes agent tools (docs/contracts/04-actions.md). */
export * from "./formats.js";
export * from "./connectors/connector.js";
export { composioConnector } from "./connectors/composio.js";
export { mcpConnector } from "./connectors/mcp.js";
export { createActions, type ActionsRegistry, type ActionsRunContext } from "./runtime/registry.js";
export { mergeOverrides, vendoSync, type SyncReportWithWarnings } from "./sync/index.js";
