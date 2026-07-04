/**
 * Audit layer (ENG-193 §6.2): contributes nothing to the decision ("allow" —
 * composePolicy takes the most restrictive sibling) and records a
 * tool_execution event after every genuine execute. Failures to write audit
 * must not fail the action: appends are awaited but errors are swallowed
 * (audit is a trail, not a gate — and a gate here would let a broken audit
 * store take down every tool).
 */
import type { AuditLog, Principal } from "@flowlet/core";
import type { ApprovalPolicy, PolicyContext } from "./types";
import { getEscalationReason } from "./escalation";

export function auditPolicy(
  audit: AuditLog,
  opts: { principalScope: (ctx: PolicyContext) => Principal; now?: () => string },
): ApprovalPolicy {
  const clock = opts.now ?? (() => new Date().toISOString());
  return {
    evaluate: () => "allow",
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
        // ENG-193 §4.2/§6: a call this policy stack escalated leaves its own
        // audit trail entry (the AuditEvent kind was declared in item 1,
        // never written until now — the judge is the first thing that
        // produces this signal).
        const reason = getEscalationReason(ctx);
        if (reason !== undefined) {
          await audit.append({
            at: clock(),
            principal: opts.principalScope(ctx),
            kind: "judge_escalation",
            toolName: ctx.toolName,
            reason,
          });
        }
      } catch {
        /* audit is a trail, not a gate */
      }
    },
  };
}
