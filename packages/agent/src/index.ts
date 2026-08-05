export { createAgent } from "./agent.js";
// §4.1 item 4 — the shipped per-tenant token ceiling, for `createAgent`'s
// `stopWhen`. Public because the ceiling belongs to whoever is being metered.
export { tokenBudgetStop } from "./loop.js";
export type { ScriptedTurn, VendoAgent } from "./agent.js";
export type { CapabilityMissConfig } from "./capability-miss.js";
export {
  buildVendoToolPack,
  type VendoPackExecuteOptions,
  type VendoPackTool,
  type VendoToolPackCoreOptions,
} from "./pack.js";
export {
  VENDO_CREATE_APP_TOOL,
  VENDO_DELEGATE_TOOL,
  VENDO_TOOL_PACK_PREFIX,
  type VendoDelegateResult,
  type VendoToolPackFilter,
  type VendoToolPackOptions,
} from "./tool-pack.js";
export { VENDO_VERB_TOOLS, vendoVerbsRegistry, type VendoVerbPorts, type VendoVerbFinding } from "./vendo-verbs.js";
export {
  CONNECTOR_DISCOVERY_TOOLS,
  USE_SERVICE_TOOL,
  connectorDiscoveryRegistry,
  type ConnectorDiscoveryPorts,
  type ServiceToolMatch,
} from "./connector-discovery.js";
export { ASK_USER_TOOL, askUserRegistry } from "./ask-user.js";
export { FIND_TOOLS_TOOL_NAME } from "./tool-search.js";
export type { ToolSearchConfig, ToolSearchFn, ToolSearchMatch } from "./tool-search.js";
// Cross-block seams the harness runtime needs live behind `@vendoai/agent/internal`,
// so a host's public surface is unchanged by the harness lift.
export type { Thread, ThreadSummary } from "./threads.js";
