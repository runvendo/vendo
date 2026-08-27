import {
  PARKED_BUILD_COLLECTION,
  type AppId,
  type ApprovalId,
  type RunContext,
  type VendoRecord,
} from "@vendoai/core";
import type { EngineOps } from "./engine.js";
import { listAllEngineRecords } from "./persistence.js";

/**
 * S3 — the offered-but-unanswered build (the propose→resume seam).
 *
 * `parked-action.ts`'s sibling, with one difference that is the whole point of
 * the slice: nothing has been called. A parked ACTION records a call the guard
 * already intercepted; a parked BUILD records a build that has not started and
 * will not start until someone says yes. So a record here is the only place the
 * ask survives — the turn that raised the card ends immediately (receipt status
 * "awaiting-consent"), and the yes may land long after it is gone.
 *
 * Keyed by the approval that gates it, so the runtime's `onApprovalDecision`
 * subscriber — the SAME seam egress and parked actions ride — can hand the
 * build to the builder the instant the owner approves. A record exists exactly
 * while its approval is undecided; both decisions clear it (approve builds then
 * clears; deny just clears — no box, ever).
 *
 * Hygiene mirrors the stores beside it: app-keyed, cleared with the app.
 */
export interface ParkedBuild {
  /** The guard approval that gates this build. */
  approvalId: ApprovalId;
  appId: AppId;
  /** The proposing principal's subject — the only principal who may approve. */
  owner: string;
  /** The person's ask, verbatim. The build brief is replayed from it, so a
   *  paraphrase (the app's capped name) is too lossy to keep instead. */
  prompt: string;
  /** The screen agent's own line for why a screen was not enough. */
  why: string;
  /** The venue the ask arrived in — the build runs with it, not with whatever
   *  context the DECISION happened to arrive on. */
  ctx: RunContext;
}

const COLLECTION = PARKED_BUILD_COLLECTION;

const parkedData = (record: VendoRecord): ParkedBuild => record.data as ParkedBuild;

export interface ParkedBuilds {
  /** Park one offered build on its guard approval (re-proposing overwrites). */
  put(build: ParkedBuild): Promise<void>;
  /** The build riding a specific guard approval id, or null if none. */
  byApproval(approvalId: ApprovalId): Promise<ParkedBuild | null>;
  /** Clear the parked build for one approval (its approval was decided, either way). */
  remove(approvalId: ApprovalId): Promise<void>;
  /** Delete every parked build for one app (app deletion cleanup). */
  clearForApp(appId: AppId): Promise<void>;
}

export const createParkedBuilds = (engine: EngineOps): ParkedBuilds => {
  return {
    async put(build) {
      await engine.put(COLLECTION, {
        id: build.approvalId,
        data: build,
        refs: { subject: build.owner, app_id: build.appId, approval: build.approvalId },
      });
    },
    async byApproval(approvalId) {
      const record = await engine.get(COLLECTION, approvalId);
      return record === null ? null : parkedData(record);
    },
    async remove(approvalId) {
      await engine.delete(COLLECTION, approvalId);
    },
    async clearForApp(appId) {
      for (const record of await listAllEngineRecords(engine, COLLECTION, { refs: { app_id: appId } })) {
        await engine.delete(COLLECTION, record.id);
      }
    },
  };
};
