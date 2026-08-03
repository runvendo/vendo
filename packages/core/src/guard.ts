import { z } from "zod";
import type { AuditEvent } from "./audit.js";
import { grantIdSchema, type ApprovalId, type GrantId } from "./ids.js";
import { approvalRequestSchema, type ApprovalRequest } from "./grants.js";
import type { Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolDescriptor } from "./tools.js";

/** 01-core §6. `"org"` (build contract §9.10) is the org-admin policy layer's
 *  strictness clamp: it appears on `ask` and `block` only, because org policy
 *  TIGHTENS and never loosens — no run is ever decided BY it. */
export type GuardDecision =
  | { action: "run"; decidedBy: "grant" | "rule" | "judge" | "default"; grantId?: GrantId }
  | { action: "ask"; approval: ApprovalRequest; decidedBy: "confirmEach" | "rule" | "judge" | "breaker" | "default" | "org" }
  | { action: "block"; reason: string; decidedBy: "rule" | "judge" | "breaker" | "denied" | "org" };

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
    decidedBy: z.enum(["confirmEach", "rule", "judge", "breaker", "default", "org"]),
  }).passthrough(),
  z.object({
    action: z.literal("block"),
    reason: z.string(),
    decidedBy: z.enum(["rule", "judge", "breaker", "denied", "org"]),
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
  /** Spend an approval's single use WITHOUT replaying its call (optional — 05 §2
   *  amendment). A yes is normally spent by the call it authorized, but the
   *  automations engine spends one by arming the app-bound standing grant its
   *  consent moment asked for (07 §3), and that spend has to contend with the
   *  replay and with `approvals.revoke` on the SAME one-time transition —
   *  otherwise a take-back and a grant mint can both "win". Answers what the
   *  caller got: `spent` (go ahead), `already-spent` (someone else did), or
   *  `taken-back` (the person revoked it — grant nothing). Callers
   *  feature-detect; a guard that omits it is used exactly as before. */
  spendApproval?(id: ApprovalId, principal: Principal): Promise<"spent" | "already-spent" | "taken-back">;
  /** genqa defect 1 (double-count) — a preview of `check()`'s verdict for a
   *  caller that is about to make (or ask the AI SDK to make) the REAL,
   *  dispatching call itself moments later for the SAME logical call: a
   *  "run" verdict here never spends the write-budget/call-rate breakers,
   *  because the follow-up call does. An "ask"/"block" verdict parks/audits
   *  exactly as `check()` does — for those outcomes this IS the only
   *  evaluation that ever runs (the agent bridge's `needsApproval` hook is
   *  the one caller today; packages/agent tools.ts). Callers feature-detect;
   *  a guard that omits it is used exactly as `check()` always was. */
  previewCheck?(call: ToolCall, descriptor: ToolDescriptor, ctx: RunContext): Promise<GuardDecision>;
}
