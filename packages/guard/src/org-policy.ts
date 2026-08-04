import { VendoError } from "@vendoai/core";
import { z } from "zod";
import type { PolicyRule } from "./types.js";
import { policyRuleSchema } from "./types.js";

/** Build contract §9.10 — the org-admin policy document, one per org, living at
 *  `/orgs/<orgId>/policy.json` in the org's workspace and managed by the
 *  console. Its own format tag: an org policy is NOT a host policy file and
 *  must never be loadable as one (the host's may say `run`; this one may not). */
export const VENDO_ORG_POLICY_FORMAT = "vendo/org-policy@1";

/** The same match vocabulary as a host rule, with `run` removed from the action
 *  axis: org policy tightens, never loosens, and that is enforced at PARSE so a
 *  console (or a hand-edited file) hears about it where the mistake was made
 *  rather than having a permissive rule silently ignored at every call. */
const orgPolicyRuleSchema = z
  .object({
    match: policyRuleSchema.shape.match,
    action: z.enum(["ask", "block"]),
    note: z.string().optional(),
  })
  .strict();

const orgPolicyFileSchema = z
  .object({
    format: z.literal(VENDO_ORG_POLICY_FORMAT),
    rules: z.array(orgPolicyRuleSchema),
  })
  .strict();

/** Parse one org's policy document. Loud on every failure — malformed JSON, a
 *  foreign format tag, an unknown match key, or `action: "run"` — with the same
 *  posture as the host policy file (`policy.ts`): a bad policy is noisy, never
 *  a silently empty one. Callers decide what a throw means for THEM; the guard
 *  applies no org rules and audits the gap. */
export function parseOrgPolicyFile(source: string, label: string): PolicyRule[] {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    throw new VendoError(
      "validation",
      `Invalid JSON in org policy ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = orgPolicyFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new VendoError(
      "validation",
      `Invalid org policy ${label}: ${parsed.error.message}`,
      parsed.error.issues,
    );
  }
  return parsed.data.rules;
}
