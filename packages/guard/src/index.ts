/** @vendoai/guard — policy, approvals, audit, safety (docs/contracts/05-guard.md). */
export { createGuard } from "./guard.js";
export { vendoAutoJudge } from "./judge.js";
// Preset expansion (00-overview decision 8): exported so a caller that needs
// a preset's ACTUAL rules outside a live guard instance (the try venue's
// demo policy.json, which ties itself to "autopilot" rather than hand-typing
// a duplicate rule) can derive them from the one place presets are defined,
// instead of drifting out of sync with a copy.
export { resolvePolicyConfig } from "./policy.js";
// Zod schemas for a .vendo/policy.json file and its rules. Public since 0.3.0
// (hosts validating a policy file before handing it to the guard); 0.4.x
// dropped them from the barrel by accident, so restore them here.
export { policyFileSchema, policyRuleSchema } from "./types.js";
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
