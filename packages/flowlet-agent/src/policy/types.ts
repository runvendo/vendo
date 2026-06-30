/**
 * Core types for the Flowlet guardrail policy engine.
 *
 * Every guardrail layer implements `ApprovalPolicy`. Layers are composed via
 * `composePolicy` which returns the most restrictive decision across all layers.
 */

import type { ToolDescriptor } from "../descriptor";
import type { FlowletPrincipal } from "../principal";

/**
 * The three possible outcomes of a policy evaluation.
 *
 * Severity order (least → most restrictive): `allow` < `approve` < `deny`.
 */
export type ApprovalDecision = "allow" | "approve" | "deny";

/** Runtime context passed to every policy layer during evaluation. */
export interface PolicyContext {
  /** Canonical name of the tool being invoked. */
  toolName: string;
  /** Raw input arguments the model supplied for the call. */
  input: unknown;
  /** Normalised descriptor captured at tool registration time. */
  descriptor: ToolDescriptor;
  /** Identity and role information for the acting principal. */
  principal: FlowletPrincipal;
}

/** A single guardrail layer. Evaluation may be async (e.g. LLM judge). */
export interface ApprovalPolicy {
  evaluate(ctx: PolicyContext): ApprovalDecision | Promise<ApprovalDecision>;
}
