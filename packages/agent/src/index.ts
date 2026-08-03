export { createAgent } from "./agent.js";
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
export { ASK_USER_TOOL, askUserRegistry } from "./ask-user.js";
export { FIND_TOOLS_TOOL_NAME } from "./tool-search.js";
export type { ToolSearchConfig, ToolSearchFn, ToolSearchMatch } from "./tool-search.js";
// Cross-block seams the harness runtime needs live behind `@vendoai/agent/internal`,
// so a host's public surface is unchanged by the harness lift.
export type { Thread, ThreadSummary } from "./threads.js";
