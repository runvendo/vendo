/**
 * Escalation-reason side channel (ENG-193 §4.2/§4.5). `ApprovalPolicy.evaluate`
 * stays `Promise<ApprovalDecision>` — a plain three-value string, unchanged —
 * so a layer that needs to attach a PLAIN-LANGUAGE REASON to one particular
 * evaluation (the judge's escalation, a breaker tripping) stamps it here,
 * keyed by the exact `PolicyContext` OBJECT INSTANCE it was given, not by
 * tool name or any other structural key.
 *
 * This works because every composition layer in this codebase passes the
 * SAME ctx object through to inner/sibling policies rather than cloning it:
 * `composePolicy` calls `policy.evaluate(ctx)` for every sibling with the one
 * ctx it received; `grantPolicy`/`judgePolicy`/the breakers all call
 * `inner.evaluate(ctx)` the same way. `wrapTool`/`wrapClientTool` build ONE
 * ctx per call (in `needsApproval`, and a SEPARATE one in `execute` — a later,
 * different SDK turn) and read this map immediately after `evaluate`
 * resolves, before that ctx is discarded.
 *
 * A `WeakMap` means an evaluated ctx that's never re-read is garbage
 * collected normally — no manual cleanup, no unbounded growth, no leak.
 */
import type { PolicyContext } from "./types";

const reasons = new WeakMap<PolicyContext, string>();

/** Stamp a plain-language reason on this exact ctx instance. */
export function setEscalationReason(ctx: PolicyContext, reason: string): void {
  reasons.set(ctx, reason);
}

/** Read back a reason stamped on this exact ctx instance, if any. */
export function getEscalationReason(ctx: PolicyContext): string | undefined {
  return reasons.get(ctx);
}
