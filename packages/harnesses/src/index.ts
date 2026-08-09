/**
 * `@vendoai/harnesses` — one central home for the thinkers, and the runtime that
 * runs any of them safely (build contract 2026-07-30 §1.6).
 *
 * The contract types themselves live in `@vendoai/core` so every block may speak
 * them; this package is the implementation half: `defineHarness`, the runtime,
 * and `vendo()` — the default in-process, key-free thinker.
 *
 * Wave 2 adds `claudeCode()`; external drivers arrive as subpaths with their SDKs
 * as optional peers (`@vendoai/harnesses/claude-code`).
 *
 * `instant()` was the third thinker and is GONE (blueprint §14.1, 2026-08-05).
 * Two engines and no third: the lean `vendo()` loop, and the builder on the
 * claude-code runtime. The specialist existed to reach a layout in seconds by
 * routing an app ask straight at the engine tool, and the paint seam now does that
 * for every harness — a plan file renders its skeleton the moment it parses,
 * whoever wrote it — so its whole reason for being was absorbed by the thing every
 * thinker already rides.
 */
export { defineHarness } from "./define.js";
export { assertHarnessComposable, type ComposedAdapters } from "./compose.js";
export {
  createHarnessRuntime,
  reportHire,
  VENDO_SUBAGENT_PART,
  type HarnessRuntime,
  type HarnessRuntimeDeps,
  type HireRecord,
  type TranscriptStore,
  type TurnRunInput,
} from "./runtime.js";
// `vendo()` itself stays on the ROOT barrel: `harness: vendo()` is the
// umbrella's documented one-liner and `@vendoai/vendo` re-exports it from here.
// Everything else that harness owns — its loop and its provider ladder — lives
// behind `@vendoai/harnesses/vendo`, one subpath per harness.
export { vendo, type HarnessHand, type VendoHarnessDeps, type VendoHarnessOptions } from "./vendo/vendo.js";
// §4.1 item 4 — the shipped per-tenant token ceiling, for a door's `stopWhen`.
// Public because the ceiling belongs to whoever is being metered.
export { tokenBudgetStop } from "./vendo/loop.js";
export {
  assembleScreen,
  escalatedPlanPath,
  screenAssembler,
  ESCALATE_TOOL,
  SAVE_APP_TOOL,
  SCREEN_STEPS,
  type ScreenAssemblerDeps,
  type ScreenInput,
  type ScreenResult,
  type ScreenSurface,
} from "./screen-agent.js";
export {
  createDiscoveryRails,
  type DiscoveryOptions,
  type DiscoveryRails,
  type MetaTool,
} from "./discovery.js";
export {
  APPROVAL_WAIT_MS,
  createApprovalWaiter,
  createTurnTools,
  type ApprovalWaiter,
  type MirrorEvent,
  type TurnToolsOptions,
} from "./turn-tools.js";
export {
  classifyHistory,
  createTurnState,
  memoryHarnessStateStore,
  type HarnessStateStore,
  type HistoryChange,
} from "./harness-state.js";
export {
  HOT_PATH_FILES,
  hotPathAppId,
  viewForWrite,
  wrapWorkspaceForRender,
  type RenderSeamOptions,
} from "./render-seam.js";
// The builder's validate gate (§7.1 item 4) — "validate must pass before done",
// as a function any harness's loop can call. Public because the loop that needs it
// is not always ours: a host's own harness driving the same workspace wants the
// same gate, and the alternative is every driver reimplementing the verb call.
export {
  repairInstruction,
  validateWrittenApps,
  VALIDATE_TOOL,
  type AppValidationFailure,
} from "./validate-gate.js";
export { THREAD_ID_HEADER, VENDO_STATUS_PART } from "./wire.js";
// The engine the doors share. These used to live in `@vendoai/agent`; they are
// here because the runtime above is their only long-term caller, and a rail can
// only drift by being changed for every door at once.
export { wireErrorMessage } from "./wire-error.js";
export {
  upsertMessage,
  validateMessage,
  validateUpsert,
} from "./transcript-rules.js";
export { type ToolBridgeOptions } from "./tool-bridge.js";
export {
  DEFAULT_MAX_INITIAL_TOOLS,
  FIND_TOOLS_TOOL_NAME,
  type ToolSearchConfig,
  type ToolSearchFn,
  type ToolSearchMatch,
  type ToolSearchSession,
} from "./tool-search.js";
export {
  latestUserIntent,
  type CapabilityMissConfig,
  type CapabilityMissDetector,
} from "./capability-miss.js";
// The materialization seam (materialize.ts) is deliberately NOT re-exported:
// its consumers are the harness drivers in this package, which reach it
// relatively. A barrel export with no reader is surface nobody asked for.
// `harnessAdapters` is the READ side: a harness constructed at boot (the host
// wrote `harness: claudeCode()`) collects the composed slots at turn time.
export { harnessAdapters, provideHarnessAdapters, type HarnessAdapters, type ToolDoorPort } from "./harness-sandbox.js";
