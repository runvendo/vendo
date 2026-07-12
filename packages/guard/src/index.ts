/** @vendoai/guard — policy, approvals, audit, safety (docs/contracts/05-guard.md). */
export { createGuard } from "./guard.js";
export { vendoAutoJudge } from "./judge.js";
export { policyFileSchema, policyRuleSchema } from "./types.js";
export type {
  Judge,
  PolicyConfig,
  PolicyFile,
  PolicyFn,
  PolicyRule,
  Scanner,
  VendoGuard,
} from "./types.js";
