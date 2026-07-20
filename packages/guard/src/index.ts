/** @vendoai/guard — policy, approvals, audit, safety (docs/contracts/05-guard.md). */
export { createGuard } from "./guard.js";
export { vendoAutoJudge } from "./judge.js";
export type {
  Judge,
  PolicyConfig,
  PolicyConfigObject,
  PolicyFile,
  PolicyFn,
  PolicyPresetName,
  PolicyRule,
  RiskResolver,
  VendoGuard,
} from "./types.js";
