/**
 * Error taxonomy for the Flowlet agent runtime.
 *
 * `FlowletError` is used for runtime exceptions that propagate through normal
 * throw/catch paths. `policyDenied` returns a plain serializable object that a
 * denied tool returns to the model — it must survive the model boundary without
 * loss, so it is intentionally not an Error instance.
 */

export type FlowletErrorCode =
  | "provider"
  | "tool"
  | "auth"
  | "policy"
  | "validation"
  | "cancelled"
  | "sandbox";

export class FlowletError extends Error {
  readonly code: FlowletErrorCode;

  constructor(code: FlowletErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "FlowletError";
  }
}

export interface PolicyDeniedPayload {
  code: "policy_denied";
  tool: string;
  rule: string;
}

export function policyDenied(tool: string, rule: string): PolicyDeniedPayload {
  return { code: "policy_denied", tool, rule };
}

/**
 * Review follow-up (wrap-tool.ts item 3): a DISTINCT code from `policy_denied`
 * for the fail-closed case where a stateful policy layer (breaker/rule/judge)
 * escalates its decision from "allow" to "approve" between `needsApproval` and
 * `execute` — no human ever saw the escalated risk, so `execute` refuses
 * rather than silently running. Not a denial (the action may well be fine
 * once a human looks at it) — a distinct code lets the model tell the two
 * apart and re-request consent instead of treating this as a hard no.
 */
export interface ApprovalRequiredPayload {
  code: "approval_required";
  tool: string;
  message: string;
}

export function approvalRequired(tool: string, message: string): ApprovalRequiredPayload {
  return { code: "approval_required", tool, message };
}
