/**
 * `@vendoai/harnesses/vendo` — the default in-process thinker and the turn loop
 * it drives.
 *
 * One folder per harness, one subpath per harness: this mirrors
 * `../claude-code/`, so a harness's driver, its loop and its provider ladder sit
 * together and are imported together. The root barrel still exports `vendo()`
 * itself (the umbrella's `harness: vendo()` one-liner); everything the loop
 * exposes — `startTurn` and its knobs, the provider ladder — lives here.
 */
export { vendo, type VendoHarnessDeps, type VendoHarnessOptions } from "./vendo.js";
export {
  startTurn,
  providerHistory,
  tokenBudgetStop,
  turnModelMessages,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_STEPS,
  type TurnContext,
  type TurnLoop,
  type TurnLoopOptions,
  type TurnCompaction,
  type TurnPrompt,
  type TurnPromptInput,
} from "./loop.js";
// The window table and its BYO override — the one new public knob of the
// context shipment, and the only part of it a host is ever meant to touch.
export {
  contextWindowTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
} from "./model-windows.js";
// The state codec, because the slot it decodes is the HOST's row: anyone reading
// `harnessStateStore` directly needs the same reader the loop uses, or the two
// disagree about a shape only one of them ships.
export {
  readCompactionState,
  writeCompactionState,
  type CompactionConfig,
  type CompactionState,
} from "./compaction.js";
// Told apart from a 429 by the same pattern set the retry uses, because a host
// driving `startTurn` itself faces the identical fork: compact and continue, or
// surface the failure.
export { isContextOverflow } from "./overflow.js";
export { failoverModel, type ResolvedModel } from "./failover.js";
