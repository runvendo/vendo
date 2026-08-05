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
// Build contract §9.10 — the org-admin policy document's parser, exported for
// the composition seam that reads `/orgs/<orgId>/policy.json` out of the
// workspace and unions the rules into the guard's `orgPolicy` resolver.
export { parseOrgPolicyFile } from "./org-policy.js";
// Agents spec — the minimal runtime↔guard seam (defined in core beside the
// full Guard), re-exported here so a host wiring a custom guard imports one
// package.
export type { GuardLike } from "@vendoai/core";
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
