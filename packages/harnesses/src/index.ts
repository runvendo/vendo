/**
 * `@vendoai/harnesses` — one central home for the thinkers, and the runtime that
 * runs any of them safely (build contract 2026-07-30 §1.6).
 *
 * The contract types themselves live in `@vendoai/core` so every block may speak
 * them; this package is the implementation half: `defineHarness`, the runtime,
 * and `vendo()` — the default in-process, key-free thinker.
 *
 * Wave 2 adds `instant()` and `claudeCode()`; external drivers arrive as subpaths
 * with their SDKs as optional peers (`@vendoai/harnesses/claude-code`).
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
export { vendo, type VendoHarnessDeps, type VendoHarnessOptions } from "./vendo.js";
export {
  instant,
  type InstantHarnessDeps,
  type InstantHarnessOptions,
} from "./instant.js";
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
export { VENDO_STATUS_PART } from "./wire.js";
// The materialization seam (materialize.ts) is deliberately NOT re-exported:
// its consumers are the harness drivers in this package, which reach it
// relatively. A barrel export with no reader is surface nobody asked for.
// `harnessAdapters` is the READ side: a harness constructed at boot (the host
// wrote `harness: claudeCode()`) collects the composed slots at turn time.
export { harnessAdapters, provideHarnessAdapters, type HarnessAdapters, type ToolDoorPort } from "./harness-sandbox.js";
