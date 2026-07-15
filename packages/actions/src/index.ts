/** @vendoai/actions — every API becomes agent tools (docs/contracts/04-actions.md). */
export * from "./formats.js";
export * from "./connectors/connector.js";
export { composioConnector } from "./connectors/composio.js";
export { mcpConnector } from "./connectors/mcp.js";
export { createActions, type ActionsRegistry, type ActionsRunContext } from "./runtime/registry.js";
export { vendoSync, type SyncReportWithWarnings } from "./sync/index.js";
export { scanComponentCatalog, type CatalogScanResult } from "./sync/catalog-scan.js";
export { mergeCatalogEntries, readCatalogFile, writeCatalog } from "./sync/catalog.js";
export {
  acceptCatalogProposals,
  proposeCatalogCopy,
  type CatalogCopyGenerator,
  type CatalogCopyRequest,
} from "./sync/catalog-ai.js";
