/**
 * Cross-block internals — NOT a host surface.
 *
 * These are the seams `@vendoai/harnesses` needs so `vendo()` rides the shipped
 * turn loop instead of reimplementing it. They live behind a subpath (the idiom
 * `@vendoai/core/conformance` and `@vendoai/apps/adapter-conformance` already
 * set) for one reason: a host's public surface must look the same after this lane
 * as before it. Anything re-exported here is free to change shape without a major
 * bump — the only supported consumer is another `@vendoai/*` block.
 */
export {
  startTurn,
  providerHistory,
  tokenBudgetStop,
  turnModelMessages,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_STEPS,
} from "./loop.js";
export { failoverModel } from "./failover.js";
export type { ResolvedModel } from "./failover.js";
export type { TurnContext, TurnLoop, TurnLoopOptions } from "./loop.js";
export { wireErrorMessage } from "./wire-error.js";
export { addAgentTool, buildAgentTools, guardedCall, previewApproval } from "./tools.js";
export type { ToolBridgeOptions } from "./tools.js";
// The four shipped rails a harness turn owes parity on. All three of these are
// authored as ai-SDK `dynamicTool`s attached into a `ToolSet`; the harness
// runtime attaches them into one of its own and reads them back as callable
// meta-tools, so there is ONE find_tools and ONE miss detector, not two.
export { createToolSearchSession, FIND_TOOLS_TOOL_NAME } from "./tool-search.js";
export type { ToolSearchSession, ToolSearchConfig } from "./tool-search.js";
export {
  CAPABILITY_MISS_TOOL_NAME,
  createCapabilityMissDetector,
  latestUserIntent,
} from "./capability-miss.js";
export type { CapabilityMissConfig, CapabilityMissDetector } from "./capability-miss.js";
export { assembleSystemPrompt } from "./prompt.js";
// The transcript-side rules a harness runtime must apply identically: what a
// client may change, and how a superseded approval resolves.
export { abandonPendingApprovals, guardApprovalIds, validateUpsert } from "./agent.js";
// The thread LIFECYCLE, shared rather than re-derived. A composition that serves
// turns through the harness runtime still has to mint ids the same way, refuse a
// foreign thread the same way, derive the same listing title, and — crucially —
// read the SAME canonical transcript `createAgent` reads. Re-deriving any of
// those would give one product two thread semantics depending on who ran the
// turn.
export { ThreadRepository } from "./threads.js";
export { validateMessage, upsertMessage } from "./agent.js";
export { THREAD_ID_HEADER } from "./agent.js";
// Tour mode's play shape. The harness door takes the same `scripted` hook as
// `createAgent`, so a scripted turn reads identically whichever door serves it.
export type { ScriptedTurn } from "./agent.js";
