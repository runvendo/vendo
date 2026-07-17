import { z } from "zod";
import type { AuditEvent } from "./audit.js";
import { grantIdSchema, type ApprovalId, type GrantId } from "./ids.js";
import { approvalRequestSchema, type ApprovalRequest } from "./grants.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolDescriptor } from "./tools.js";

/** 01-core §6 */
export type GuardDecision =
  | { action: "run"; decidedBy: "grant" | "rule" | "judge" | "default"; grantId?: GrantId }
  | { action: "ask"; approval: ApprovalRequest; decidedBy: "critical" | "rule" | "judge" | "breaker" | "default" }
  | { action: "block"; reason: string; decidedBy: "rule" | "judge" | "scanner" | "breaker" };

/** 01-core §6 */
export const guardDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("run"),
    decidedBy: z.enum(["grant", "rule", "judge", "default"]),
    grantId: grantIdSchema.optional(),
  }).passthrough(),
  z.object({
    action: z.literal("ask"),
    approval: approvalRequestSchema,
    decidedBy: z.enum(["critical", "rule", "judge", "breaker", "default"]),
  }).passthrough(),
  z.object({
    action: z.literal("block"),
    reason: z.string(),
    decidedBy: z.enum(["rule", "judge", "scanner", "breaker"]),
  }).passthrough(),
]) satisfies z.ZodType<GuardDecision>;

/** 01-core §6 */
export interface Guard {
  check(call: ToolCall, descriptor: ToolDescriptor, ctx: RunContext): Promise<GuardDecision>;
  report(event: AuditEvent): Promise<void>;
  directions(ctx: RunContext): Promise<string[]>;
  onApprovalDecision(cb: (id: ApprovalId, approved: boolean) => void): () => void;
  /** AGENT-6 (wave 5, optional — 01 §6 amendment parked): resolve approvals
   *  the conversation abandoned (a fresh user turn superseded an undecided
   *  ask). Implementations deny them — subject-scoped to `ctx.principal`,
   *  idempotent, never minting a grant — so the pending queue tracks the
   *  thread instead of accreting forever. Callers feature-detect. */
  abandonApprovals?(ids: ApprovalId[], ctx: RunContext): Promise<void>;
}
