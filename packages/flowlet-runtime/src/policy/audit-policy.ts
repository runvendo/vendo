/**
 * Audit layer (ENG-193 §6.2): contributes nothing to the decision ("allow" —
 * composePolicy takes the most restrictive sibling) and records a
 * tool_execution event after every genuine execute. Failures to write audit
 * must not fail the action: appends are awaited but errors are swallowed
 * (audit is a trail, not a gate — and a gate here would let a broken audit
 * store take down every tool).
 *
 * COMPOSITION CONTRACT: compose this sibling LAST —
 * `composePolicy(<judge/breaker chain>, auditPolicy(...))`. `composePolicy`
 * evaluates siblings in order with ONE shared ctx, so only a
 * last-place audit sibling observes the escalation reason the chain just
 * stamped. That evaluate-time observation is what lets a DECLINED escalation
 * (needsApproval → user says no → execute never runs) still leave a
 * `judge_escalation` trail entry. Appends are deduped per toolCallId
 * (bounded FIFO) so the SDK's double-evaluate (needsApproval + execute) and
 * the onExecuted path together yield exactly ONE event per escalated call.
 */
import type { AuditLog, Principal } from "@flowlet/core";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import { getEscalationReason } from "./escalation";

/** Bound on the recorded-escalation FIFO — plenty for the SDK's
 *  evaluations-per-call window, tiny enough to never matter. */
const MAX_RECORDED_IDS = 256;

export function auditPolicy(
  audit: AuditLog,
  opts: { principalScope: (ctx: PolicyContext) => Principal; now?: () => string },
): ApprovalPolicy {
  const clock = opts.now ?? (() => new Date().toISOString());
  // toolCallIds whose judge_escalation was already appended (bounded FIFO).
  const recorded = new Set<string>();

  function alreadyRecorded(toolCallId: string | undefined): boolean {
    if (toolCallId === undefined) return false; // id-less ctx (bare tests) — never dedupe
    if (recorded.has(toolCallId)) return true;
    recorded.add(toolCallId);
    if (recorded.size > MAX_RECORDED_IDS) {
      const oldest = recorded.values().next().value;
      if (oldest !== undefined) recorded.delete(oldest);
    }
    return false;
  }

  async function appendEscalation(ctx: PolicyContext, reason: string): Promise<void> {
    await audit.append({
      at: clock(),
      principal: opts.principalScope(ctx),
      kind: "judge_escalation",
      toolName: ctx.toolName,
      reason,
    });
  }

  return {
    async evaluate(ctx): Promise<ApprovalDecision> {
      // ENG-193 §4.2/§6: a call this policy stack escalated leaves its own
      // audit trail entry EVEN IF the user then declines it (execute — and
      // so onExecuted — never runs for a declined call). Works because this
      // sibling is composed LAST (see the module docstring).
      try {
        const reason = getEscalationReason(ctx);
        if (reason !== undefined && !alreadyRecorded(ctx.toolCallId)) {
          await appendEscalation(ctx, reason);
        }
      } catch {
        /* audit is a trail, not a gate */
      }
      return "allow";
    },
    async onExecuted(ctx) {
      try {
        await audit.append({
          at: clock(),
          principal: opts.principalScope(ctx),
          kind: "tool_execution",
          toolName: ctx.toolName,
          toolCallId: ctx.toolCallId ?? "unknown",
          mutating: ctx.descriptor.annotations.readOnlyHint !== true,
          dangerous: ctx.descriptor.annotations.destructiveHint === true,
          outcome: "ok",
        });
        // Fallback for a ctx whose escalation evaluate never saw (a host
        // composing audit first, or a direct onExecuted in tests) — same
        // dedupe, so the common path never double-writes.
        const reason = getEscalationReason(ctx);
        if (reason !== undefined && !alreadyRecorded(ctx.toolCallId)) {
          await appendEscalation(ctx, reason);
        }
      } catch {
        /* audit is a trail, not a gate */
      }
    },
  };
}
