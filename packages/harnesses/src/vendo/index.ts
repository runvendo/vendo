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
} from "./loop.js";
export { failoverModel, type ResolvedModel } from "./failover.js";
