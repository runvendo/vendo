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
