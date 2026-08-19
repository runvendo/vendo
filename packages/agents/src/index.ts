/**
 * `@vendoai/agents` — spawn a governed, harness-grade agent in any Node
 * backend in a few lines. One runtime, always host-run; a Vendo Cloud key
 * fills the sandbox slot when it is left unset. The engines are DEFINED in
 * `@vendoai/harnesses` and re-exported here, so a host installs one package.
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
  agentAutomationPlan,
  agentAutomations,
  type OnOptions,
} from "./automations.js";
export { awayRunner, type AwayRunnerDeps, type RunOptions } from "./away.js";
/** The turn a verb hands back, and the two shapes a caller writes against it. */
export type { ChatOptions, RunEvent, Turn } from "./turn.js";
export { DOOR_PATH, type DoorConfig } from "./door.js";
/** One user, bound once — what `agent.forUser(subject)` hands back. */
export {
  createUser,
  type AgentUser,
  type Memories,
  type Threads,
  type UserChatOptions,
  type UserOptions,
  type UserThread,
} from "./facade.js";
/** One mount for the whole agent — the chat wire, the thread lifecycle, and the
 *  door and permission planes it already serves. */
export { agentHandler, type HandlerOptions, type HandlerUser } from "./handler.js";
/** Interrupted turns, addressed by id — the same park a caller holding the
 *  result answers through `TurnResult.resume()`, from any other process. */
export {
  createTurns,
  PARKED_TURN_TTL_MS,
  type InterruptedTurn,
  type Turns,
} from "./interruptions.js";
export {
  MEMORY_RECALL_LIMIT,
  MEMORY_TEXT_MAX_CHARS,
  storeMemory,
  type Memory,
  type MemoryAdapter,
} from "./memory.js";
export { PERMISSIONS_PATH, type AgentPrincipal } from "./permissions.js";
export { assemblePrompt, type PromptInput, type SystemPromptHook } from "./prompt.js";
export { serve, type ServeOptions, type VendoRuntime } from "./serve.js";
export type { AgentSession, ApprovalEvent, RespondOptions, SessionOptions } from "./session.js";
export {
  api,
  tool,
  type ApiOptions,
  type HostTool,
  type McpServerConfig,
  type ToolConfig,
  type ToolInput,
  type ToolSource,
} from "./tools.js";
export type { EgressConfig } from "./egress.js";
export type { RunContext } from "@vendoai/core";
/** The turn contract, from the one package a host installed. It is DEFINED in
 *  `@vendoai/core` — one definition, every block speaks it — and re-exported
 *  here so nobody has to add a second dependency to name what a turn returned.
 *  `TurnResult` is the exception, and only because core cannot name the `Turn`
 *  its `resume()` hands back: turn.ts binds that one parameter and nothing
 *  else. */
export type {
  Decision,
  Decisions,
  Interruption,
  Question,
  ResumeOptions,
  TurnUsage,
} from "@vendoai/core";
export type { TurnResult } from "./turn.js";
export { decisionSchema, decisionsSchema, interruptionSchema, questionSchema } from "@vendoai/core";
/** The header `respond()` and `session.stream()` return the conversation's id
 *  on, and the one `@vendoai/ui` reads it from. Named, not spelled out, so a
 *  host and the browser cannot drift onto two literals. */
export { THREAD_ID_HEADER, type UsageTotals } from "@vendoai/harnesses";
/** The default engine, from the one package a host installed — DEFINED in
 *  `@vendoai/harnesses`, re-exported here, never a second copy. `claudeCode()`
 *  is its own subpath (`@vendoai/agents/claude-code`) for the reason it is one
 *  in harnesses: its SDK needs Node built-ins, and this barrel is bundled for
 *  Worker targets through `packages/vendo/src/server.ts` (portability-gate.mjs). */
export { vendo, type VendoHarnessOptions } from "@vendoai/harnesses";

export { createGuard, type GuardLike, type VendoGuard } from "@vendoai/guard";
