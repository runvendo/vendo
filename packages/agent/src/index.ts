export { createAgent } from "./agent.js";
export type { VendoAgent } from "./agent.js";
/** Umbrella-internal: dev-mode rider warmup assembles the same system prompt
 *  the loop uses (ENG-338); not a stable host-facing API. */
export { assembleSystemPrompt } from "./prompt.js";
export type {
  RiderSession,
  RiderSessionProvider,
  RiderSessionStart,
  RiderToolResult,
} from "./rider.js";
export { CAPABILITY_MISS_TOOL_NAME } from "./capability-miss.js";
export type { CapabilityMissConfig } from "./capability-miss.js";
export {
  VENDO_TOOLS_SEARCH_TOOL_NAME,
  DEFAULT_MAX_INITIAL_TOOLS,
  computeInitialLoadout,
} from "./tool-search.js";
export type { ToolSearchConfig, ToolSearchFn, ToolSearchMatch } from "./tool-search.js";
export type { Thread, ThreadSummary } from "./threads.js";
