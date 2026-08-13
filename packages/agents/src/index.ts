/**
 * `@vendoai/agents` — spawn a governed, harness-grade agent in any Node
 * backend in a few lines. One runtime, always host-run; a Vendo Cloud key
 * fills the sandbox slot when it is left unset. Harness factories live in
 * `@vendoai/harnesses` (`claudeCode`, `vendo`).
 */
export {
  agent,
  agentComposition,
  e2b,
  postgres,
  provideCloudAdapters,
  type AgentComposition,
  type AgentConfig,
  type CloudAdapters,
  type E2bOptions,
  type PostgresOptions,
  type VendoAgent,
} from "./agent.js";
export {
  awayRunner,
  type AgentReport,
  type AgentRun,
  type AwayRunnerDeps,
  type RunEvent,
  type RunOptions,
} from "./away.js";
export { DOOR_PATH, type DoorConfig } from "./door.js";
export { assemblePrompt, type PromptInput } from "./prompt.js";
export type { AgentSession, ApprovalEvent, RespondOptions, SessionOptions } from "./session.js";
export {
  api,
  tool,
  type ApiOptions,
  type HostTool,
  type McpServerConfig,
  type ToolConfig,
  type ToolSource,
} from "./tools.js";
export type { EgressConfig } from "./egress.js";
export type { RunContext } from "@vendoai/core";
/** The header `respond()` and `session.stream()` return the conversation's id
 *  on, and the one `@vendoai/ui` reads it from. Named, not spelled out, so a
 *  host and the browser cannot drift onto two literals. */
export { THREAD_ID_HEADER, type UsageTotals } from "@vendoai/harnesses";

export { createGuard, type GuardLike, type VendoGuard } from "@vendoai/guard";
