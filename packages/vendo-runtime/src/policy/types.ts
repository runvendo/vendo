/**
 * Core types for the Vendo guardrail policy engine.
 *
 * Every guardrail layer implements `ApprovalPolicy`. Layers are composed via
 * `composePolicy` which returns the most restrictive decision across all layers.
 */

import type { ToolDescriptor } from "../descriptor";
import type { VendoPrincipal } from "../principal";

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
  principal: VendoPrincipal;
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
  /**
   * The user utterance driving this turn (ENG-193 §4.2) — the text the judge
   * matches a proposed call's intent against. Assembled by the engine from
   * the latest user message in the run (`policy/run-context.ts`); absent for
   * an automation firing (there is no live turn — §4.6, the judge does not
   * run there at all, see judge-policy.ts).
   */
  request?: { text: string; messageId: string };
  /**
   * Tool names whose RESULTS returned earlier in THIS run and are
   * openWorld/composio-sourced or unverified — i.e. external content already
   * entered the model's context this turn (ENG-193 §4.2/§5's "provenance"
   * question). Assembled fresh per call by `RunPolicyContext`.
   */
  provenance?: { taintedSources: string[] };
  /** This run's own tool-call tally so far (ENG-193 §4.2's "escalation"
   *  question — a sudden burst is itself a signal). */
  counters?: { toolCallsThisTurn: number; perTool: Record<string, number> };
  /**
   * Reserved for the automation interpreter (item 4) to identify an
   * unattended firing. NOT populated by this item's code — every context
   * this item builds either has a `threadId` (chat) or has neither `runContext`
   * nor `threadId` (automations, unchanged from item 1/2). Declared now
   * (additive) so item 4 doesn't need another contract change.
   */
  runContext?: { automationId: string; version: number };
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
