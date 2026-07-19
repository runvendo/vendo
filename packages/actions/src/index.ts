/** @vendoai/actions — every API becomes agent tools (docs/contracts/04-actions.md). */
export * from "./formats.js";
export * from "./connectors/connector.js";
export { composioConnector } from "./connectors/composio.js";
export { composioToolRisk } from "./connectors/composio-risk.js";
export { mcpConnector, type McpAuthContext, type McpHeadersResolver } from "./connectors/mcp.js";
export { createActions, type ActionsRegistry, type ActionsRunContext, type ServerActionHandler } from "./runtime/registry.js";
export { searchToolDescriptors, type ToolSearchMatch, type ToolSearchOptions } from "./runtime/search.js";
export { validateCapabilities, type CapabilityIssue, type PrimitiveStepTarget } from "./runtime/compound.js";
export { walkSteps, STEP_FOREACH_MAX_ITEMS, type StepResumePoint, type StepWalkOptions, type StepWalkResult } from "./runtime/steps.js";
export { mergeOverrides, vendoSync, type SyncReportWithWarnings } from "./sync/index.js";
export {
  extractServerActions,
  serverActionKey,
  serverActionRegistrations,
  type ServerActionRegistration,
  type ServerActionsExtractResult,
} from "./sync/server-actions.js";
export { scanRemixRegistrations, type RemixRegistrationSite } from "./sync/pins.js";
export { scanComponentCatalog, type CatalogScanResult } from "./sync/catalog-scan.js";
export { mergeCatalogEntries, readCatalogFile, writeCatalog } from "./sync/catalog.js";
// The static zod → JSON Schema interpreter (04 §1). Exported so the
// composition can pin static/runtime derivation parity in tests — sync's
// static output feeds the ajv-compiled disk validator while the runtime
// derives from the live zod object, and the two must agree.
export {
  parseModule,
  zodFromExpression,
  type FileModule,
  type StaticExtraction,
  type ZodSchemaResult,
} from "./sync/static-ts.js";
