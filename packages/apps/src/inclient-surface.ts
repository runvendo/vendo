/**
 * 06-apps §9 — `AppsRuntime.inClient`, the additive trust-axis surface.
 *
 * Lifted out of `createApps` unchanged. OSS carries the enforcement machinery:
 * the ship-diff a reviewer reads, the stored approval records, and the hash-pin
 * verdict `open()` rides to the client.
 */
import { VendoError } from "@vendoai/core";
import { rowFromRecord } from "./persistence.js";
import { classifyLegacyPlacements } from "./pins.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import { computeShipDiff } from "./ship-diff.js";
import type { AppsRuntime } from "./types.js";
import { appVersionHash } from "./version-hash.js";

export type InClientSurfaceDeps = Pick<
  AppsRuntimeContext,
  | "config"
  | "apps"
  | "inClientApprovals"
  | "review"
  | "holds"
  | "requireOwned"
  | "reviewerAsserted"
  | "reportLifecycle"
>;

export const createInClientSurface = (deps: InClientSurfaceDeps): AppsRuntime["inClient"] => {
  const {
    config,
    apps,
    inClientApprovals,
    review,
    holds,
    requireOwned,
    reviewerAsserted,
    reportLifecycle,
  } = deps;
  return {
  async shipDiff(appId, ctx) {
    const app = await requireOwned(appId, ctx, "viewer");
    return computeShipDiff(app, config.pinBaselines ?? []);
  },
  async approvals(appId, ctx) {
    await requireOwned(appId, ctx, "viewer");
    return inClientApprovals.list(appId);
  },
  async verdict(appId, ctx) {
    const app = await requireOwned(appId, ctx, "viewer");
    return inClientApprovals.verdictFor(app);
  },
  async approve(input, ctx) {
    // Round-2 hardening (2026-08-02) — a review-kind approval IS the
    // review, so it never comes from the remixing user themselves: the
    // requester is refused unless the host's reviewer assertion
    // (apps.review.reviewer) covers them, and an asserted reviewer may
    // approve across the owner boundary (that is the reviewer's job).
    // Instant-kind keeps the plain access scoping unchanged.
    const record = await apps.get(input.appId);
    if (record === null) throw new VendoError("not-found", `app not found: ${input.appId}`);
    const row = rowFromRecord(record);
    const app = classifyLegacyPlacements(row.doc, config.pinBaselines);
    // `holds` rather than a bare subject compare: the row is read WITHOUT
    // owner scoping here (a reviewer crosses that boundary), so the access
    // question is asked through the ONE permission check — which keeps the
    // org/sharing editor reaching their own team's app. Neither branch ever
    // approves; only which refusal the caller is told apart.
    const permitted = await holds(input.appId, ctx, "editor", record);
    if (review.isReviewKind(app)) {
      if (!await reviewerAsserted(ctx)) {
        if (permitted) {
          throw new VendoError("blocked", "a review-kind remix cannot be approved by its own user — set apps.review.reviewer(ctx) in your composition to assert who reviews");
        }
        // Masked like every unreachable app read.
        throw new VendoError("not-found", `app not found: ${input.appId}`);
      }
    } else if (!permitted) {
      throw new VendoError("not-found", `app not found: ${input.appId}`);
    }
    const approval = await inClientApprovals.record({
      appId: app.id,
      versionHash: appVersionHash(app),
      approvedBy: input.approvedBy,
      at: new Date().toISOString(),
    });
    await reportLifecycle("in-client-approve", app.id, ctx, {
      versionHash: approval.versionHash,
      approvedBy: approval.approvedBy,
    });
    return approval;
  },
  };
};
