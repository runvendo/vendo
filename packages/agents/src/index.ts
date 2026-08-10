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
export { awayRunner, type AwayRunnerDeps } from "./away.js";
export { DOOR_PATH, type DoorConfig } from "./door.js";
export { assemblePrompt, type PromptInput } from "./prompt.js";
export type { AgentSession, ApprovalEvent, SessionOptions } from "./session.js";
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

export { createGuard, type GuardLike, type VendoGuard } from "@vendoai/guard";
