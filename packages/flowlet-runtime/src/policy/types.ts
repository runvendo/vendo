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
  /**
   * ai SDK toolCallId (ENG-193 §4.2 first slice; the fuller judge context
   * lands in item 3). Present in execute-path contexts, absent at preflight
   * (`needsApproval` has no `toolCallId` to thread).
   */
  toolCallId?: string;
  /**
   * Stable per-conversation id (ENG-193 §4.3 contextKey — enables
   * session/task-duration grants). Absent when the caller supplied none; the
   * engine falls back to its own minted run id (see engine.ts).
   */
  threadId?: string;
}

/** A single guardrail layer. Evaluation may be async (e.g. LLM judge). */
export interface ApprovalPolicy {
  evaluate(ctx: PolicyContext): ApprovalDecision | Promise<ApprovalDecision>;
  /**
   * Optional hook invoked by `wrapTool` AFTER the real tool successfully
   * executes — i.e. the call was `allow`, or it was `approve`, the user
   * approved it, and the real `execute` ran to completion.
   *
   * `decision` is the FRESH execute-time decision that was actually enforced
   * (`"allow"` or `"approve"`). It lets a layer distinguish an auto-allowed
   * call from a human-approved one (e.g. ask-once memoisation records only
   * `"approve"`, never `"allow"`).
   *
   * It is NEVER called for a `deny` (the tool did not run), nor if the real
   * `execute` throws or aborts. Layers use it to record that a call genuinely
   * happened, so nothing is recorded merely because a prompt was shown.
   */
  onExecuted?(
    ctx: PolicyContext,
    decision: ApprovalDecision,
  ): void | Promise<void>;
}
