import { z } from "zod";
import type { AuditEvent } from "./audit.js";
import { grantIdSchema, type ApprovalId, type GrantId } from "./ids.js";
import { approvalRequestSchema, type ApprovalRequest, type MintGrantInput } from "./grants.js";
import type { Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolDescriptor } from "./tools.js";

/** 01-core §6. `"org"` (build contract §9.10) is the org-admin policy layer's
 *  strictness clamp: it appears on `ask` and `block` only, because org policy
 *  TIGHTENS and never loosens — no run is ever decided BY it. `"frozen"` is the
 *  guard's emergency stop, and blocks only: it refuses rather than parking,
 *  because there is nothing for anyone to answer. */
export type GuardDecision =
  | { action: "run"; decidedBy: "grant" | "rule" | "judge" | "default"; grantId?: GrantId }
  | { action: "ask"; approval: ApprovalRequest; decidedBy: "confirmEach" | "rule" | "judge" | "breaker" | "default" | "org" }
  | { action: "block"; reason: string; decidedBy: "rule" | "judge" | "breaker" | "denied" | "org" | "frozen" };

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
    decidedBy: z.enum(["rule", "judge", "breaker", "denied", "org", "frozen"]),
  }).passthrough(),
]) satisfies z.ZodType<GuardDecision>;

/** Agents spec (existing-package changes) — the minimal seam a runtime
 *  requires of its guard. `check` is the law: every tool call passes through
 *  it and comes back run / ask / block. Audit reporting and the
 *  approval-decision subscription are optional, feature-detected extras.
 *  `Guard` below extends it, so every full guard (the guard package's
 *  VendoGuard included) already satisfies it. */
export interface GuardLike {
  check(call: ToolCall, descriptor: ToolDescriptor, ctx: RunContext): Promise<GuardDecision>;
  report?(event: AuditEvent): Promise<void>;
  onApprovalDecision?(cb: (id: ApprovalId, approved: boolean) => void): () => void;
  /** The park-side mirror of `onApprovalDecision`: fires when a check parks an
   *  approval, with the persisted request. Optional — required on the guard
   *  package's VendoGuard — because existing implementations predate it;
   *  callers feature-detect. */
  onApprovalRequested?(cb: (request: ApprovalRequest) => void): () => void;
}

/** 01-core §6 — `GuardLike`'s seam plus `directions`, with the two optional
 *  members a full guard must actually have narrowed to required. `check` and
 *  `onApprovalRequested` are inherited verbatim. */
export interface Guard extends GuardLike {
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
  /** Mint the grant a decided approval turns into (optional — same
   *  feature-detected shape as `spendApproval`). The guard's own decide path
   *  mints through this, and so does the automations engine's consent moment,
   *  so there is ONE implementation of what a remembered yes becomes rather
   *  than one per caller. A guard that omits it leaves the caller writing the
   *  row itself, from the same `buildGrant`. */
  mintGrant?(input: MintGrantInput): Promise<GrantId>;
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
