/**
 * Remix final shape (2026-08-02) — `AppsRuntime.review`, the reviewer's side of
 * the review-kind lifecycle.
 *
 * Lifted out of `createApps` unchanged. Both verbs cross owner boundaries BY
 * DESIGN (the reviewer is not the remixing user), so both are gated on the
 * host's reviewer assertion (`AppsConfig.review.reviewer`).
 */
import { VendoError } from "@vendoai/core";
import { APPS_COLLECTION, rowFromRecord } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime } from "../runtime/types.js";

export type ReviewSurfaceDeps = Pick<
  AppsRuntimeContext,
  "config" | "engine" | "review" | "reviewerAsserted" | "reportGuard"
>;

export const createReviewSurface = (deps: ReviewSurfaceDeps): AppsRuntime["review"] => {
  const { config, engine, review, reviewerAsserted, reportGuard } = deps;
  return {
  async queue(ctx) {
    const entries = await review.queue();
    if (await reviewerAsserted(ctx)) return entries;
    // No reviewer assertion → a caller sees only their own submissions;
    // nobody reads another user's pending fork source through this door.
    return entries.filter((entry) => entry.requester === ctx.principal.subject);
  },
  async reject(input, ctx) {
    // Rejecting is reviewer-only, and reviewing is a HOST trust decision:
    // it requires the composition's explicit assertion, in every venue.
    if (config.review?.reviewer === undefined) {
      throw new VendoError("blocked", "rejecting a remix review requires the host's reviewer assertion — set apps.review.reviewer(ctx) in your composition");
    }
    if (!await reviewerAsserted(ctx)) {
      // Masked like every unowned app read: a non-reviewer learns nothing.
      throw new VendoError("not-found", `app not found: ${input.appId}`);
    }
    // Reviewer-side, cross-subject by design: the app is looked up
    // WITHOUT owner scoping (the reviewer assertion above stands in front).
    const record = await engine.get(APPS_COLLECTION, input.appId);
    if (record === null) throw new VendoError("not-found", `app not found: ${input.appId}`);
    const row = rowFromRecord(record);
    const doc = row.doc;
    const rejection = await review.reject({ doc, note: input.note, by: ctx.principal.subject });
    // The audit event lands under the OWNER's subject so the rejection is
    // loud in the remixing user's activity, not the reviewer's.
    await reportGuard(row.subject, doc.id, ctx, {
      operation: "review-reject",
      versionHash: rejection.versionHash,
      by: rejection.by,
      note: rejection.note,
    });
    return rejection;
  },
  };
};
