import type { ApprovalId, IsoDateTime } from "./ids.js";
import type { ToolOutcome } from "./tools.js";

/**
 * What became of a guarded call the guard PARKED, once its approval is decided.
 *
 * Two lanes park calls and both resume them from the SAME
 * `guard.onApprovalDecision` seam: the venue-neutral BYO one
 * (`packages/vendo/src/byo-approvals.ts`) and the apps runtime's in-app actions
 * (`packages/apps/src/server/persistence/parked-action.ts`). By the time either
 * resumes, the surface that asked is long gone from the call stack — a foreign
 * agent loop, or a generated screen sitting on "Sending…" — so the answer is
 * PERSISTED here, keyed by the approval, and `GET /approvals/:id` serves it back.
 *
 * The shape and the collection live in core because both writers and the single
 * reader must agree on them and none of them may import each other (layering).
 */
export const PARKED_CALL_OUTCOME_COLLECTION = "vendo_parked_call_outcome";

export interface ParkedCallOutcome {
  approvalId: ApprovalId;
  /** The parking principal's subject — the only principal who may read it. */
  owner: string;
  state: "executed" | "declined" | "expired";
  /** Present for "executed": the resumed call's outcome, errors included. */
  outcome?: ToolOutcome;
  at: IsoDateTime;
}
