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

/**
 * The apps lane's PARKED record, keyed by approval — written when an in-app
 * action parks, cleared only after the outcome row above is written. So "this
 * record exists" is exactly the window where the decision has already left the
 * guard's pending queue and the answer is not readable yet, and the read
 * (`byo-approvals.ts`) answers "pending" through it instead of a terminal
 * not-found the surface would render as expired. Here for the same reason the
 * outcome shape is: one writer, one reader, no import between them.
 */
export const PARKED_ACTION_COLLECTION = "vendo_parked_action";

export interface ParkedCallOutcome {
  approvalId: ApprovalId;
  /** The parking principal's subject — the only principal who may read it. */
  owner: string;
  state: "executed" | "declined" | "expired";
  /** Present for "executed": the resumed call's outcome, errors included. */
  outcome?: ToolOutcome;
  at: IsoDateTime;
}
