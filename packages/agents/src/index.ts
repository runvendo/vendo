/**
 * `@vendoai/agents` — spawn a governed, harness-grade agent in any Node
 * backend in a few lines. One runtime, always host-run; a Vendo Cloud key
 * fills every slot left unset. Harness factories live at
 * `@vendoai/agents/harnesses` (`claudeCode`, `vendo`).
 */
export {
  agent,
  e2b,
  postgres,
  provideCloudAdapters,
  type AgentConfig,
  type CloudAdapters,
  type E2bOptions,
  type PostgresOptions,
  type VendoAgent,
} from "./agent.js";
export type { AgentSession, ApprovalEvent, SessionOptions } from "./session.js";
export { api, tool, type ApiOptions, type HostTool, type ToolConfig, type ToolSource } from "./tools.js";
export type { McpServerConfig } from "./mcp.js";
export type { EgressConfig } from "./egress.js";
export type { EnrichedRunContext, GuardLike } from "./pending-types.js";

export { createGuard } from "@vendoai/guard";
export { s3 } from "@vendoai/store";
export { vendoKnowledge } from "@vendoai/knowledge";
