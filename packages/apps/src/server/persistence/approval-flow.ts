/**
 * The one place a decided approval is landed. Two lanes park work against the
 * guard's `onApprovalDecision` seam and resume here: an in-app action, and a
 * consented build. By the time either fires the surface that asked is long
 * gone, so the record is what carries the intent, not the call stack.
 */
import { type ApprovalId } from "@vendoai/core";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";

const subscribeApprovalDecisions = (
  deps: Pick<AppsRuntimeContext,
    "config" | "parkedActions" | "parkedBuilds" | "build">,
): void => {
  const { config, parkedActions, parkedBuilds, build } = deps;
  const onApprovalDecision = async (id: ApprovalId, approved: boolean): Promise<void> => {
    // W0 — resume a parked in-app action. Approval makes the exact parked call
    // eligible for the guard's one-shot approved replay, so re-dispatching it
    // through the guard-bound registry runs it and lands the host effect. The
    // record clears either way (approve = ran; deny = fail closed, never runs).
    const parkedAction = await parkedActions.byApproval(id);
    if (parkedAction !== null) {
      try {
        // Contained: a failed resume must never roll back the approval (the
        // guard already swallows subscriber throws, but be explicit here so
        // the record is always cleared). The resume's ANSWER is persisted
        // beside the effect — the screen that pressed the button is not on this
        // call stack and learns what happened only by reading it back.
        if (approved) {
          const outcome = await config.tools.execute(parkedAction.call, parkedAction.ctx);
          await parkedActions.resolve(parkedAction, { state: "executed", outcome });
        } else {
          await parkedActions.resolve(parkedAction, { state: "declined" });
        }
      } finally {
        await parkedActions.remove(id);
      }
    }

    // S3 — the person's yes (or no) on a STANDING build card, which may land
    // long after the turn that raised it. Nothing was called when the card went
    // up, so this decision is not a resumption but the START: it is the only
    // path from an escalated ask to a build box. The record clears either way
    // (approve builds and clears; deny clears, and no box is ever opened).
    const parkedBuild = await parkedBuilds.byApproval(id);
    if (parkedBuild !== null) {
      try {
        await build.resume(id, approved);
      } finally {
        await parkedBuilds.remove(id);
      }
    }
  };
  config.guard.onApprovalDecision((id, approved) => onApprovalDecision(id, approved));
};

/** The approval-resume slice of `createApps`' closure: one subscription, and
 *  the parked records it lands. */
export const createApprovalFlow = (
  deps: Pick<AppsRuntimeContext,
    "config" | "parkedActions" | "parkedBuilds" | "build">,
): void => {
  subscribeApprovalDecisions(deps);
};
