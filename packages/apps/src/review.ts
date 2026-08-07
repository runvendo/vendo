import {
  VendoError,
  appIdSchema,
  isoDateTimeSchema,
  sha256Hex,
  type AppDocument,
  type AppId,
  type IsoDateTime,
  type RecordStore,
  type StoreAdapter,
} from "@vendoai/core";
import { z } from "zod";
import type { AppHistoryAccess } from "./history.js";
import type { InClientApprovalAccess, InClientVenueState, ReviewStanding } from "./inclient.js";
import type { PinBaseline } from "./pins.js";
import { documentFromRecord, listAllRecords, rowFromRecord } from "./persistence.js";
import { computeShipDiff, type ShipDiff } from "./ship-diff.js";
import { appVersionHash } from "./version-hash.js";

/**
 * Remix final shape (2026-08-02) — one reviewer rejection of one exact app
 * version. The work is NOT deleted: the note goes back to the user's panel,
 * and a new version supersedes the rejection (the resubmission count on the
 * review queue increments).
 */
export interface RemixRejection {
  appId: AppId;
  versionHash: string;
  note: string;
  by: string;
  at: IsoDateTime;
}

/** Validated persisted representation of a remix rejection. */
export const remixRejectionSchema = z.object({
  appId: appIdSchema,
  versionHash: z.string(),
  note: z.string().min(1),
  by: z.string(),
  at: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<RemixRejection>;

/**
 * One pending review-kind version awaiting the host reviewer, as
 * `GET /apps/review-queue` lists it. `shipDiff` is the review artifact —
 * the fork's unified diff against the captured baseline, hash-pinned to
 * the version an approval would cover.
 */
export interface ReviewQueueEntry {
  appId: AppId;
  /** The remixing user (the app's owner subject). */
  requester: string;
  /** The review-kind host slot this fork pins (first of several, if ever). */
  slot: string;
  versionHash: string;
  /** When this version landed (the app row's last write). */
  submittedAt: IsoDateTime;
  /** Prior rejections superseded by newer versions of this app. */
  resubmissions: number;
  shipDiff: ShipDiff;
}

const COLLECTION = "vendo_remix_rejections";

/**
 * Remix final shape (2026-08-02) — review-kind gating over the hash-pinned
 * in-client approval machinery (inclient.ts). An app forked from a baseline
 * captured with `review: true` is invisible to its own user until a host
 * reviewer approves: open() serves the newest APPROVED version (or, before
 * any approval, a pending state the client resolves to the ORIGINAL host
 * component — a jailed fork render never occurs for review-kind).
 */
export interface ReviewLifecycle {
  /** Kind is capture metadata: any fork pin whose baseline carries `review: true`. */
  isReviewKind(doc: AppDocument): boolean;
  /**
   * The document open() serves. Review-kind and the current version
   * unapproved → the newest approved version from the existing history
   * (content is never re-minted); none approved → the current document,
   * whose venue state below withholds every executable source.
   */
  serveDocFor(current: AppDocument): Promise<AppDocument>;
  /**
   * The opener's venue callback. Instant-kind delegates to the plain
   * hash-pin venue; review-kind never answers with a jail state — an
   * unapproved version rides `pending-review` (with the rejection note when
   * the reviewer left one), and a served older version carries the current
   * version's standing as the `review` rider.
   */
  venueStateFor(doc: AppDocument): Promise<InClientVenueState | undefined>;
  /** Every review-kind version awaiting review, oldest submission first. */
  queue(): Promise<ReviewQueueEntry[]>;
  /** Persist one rejection of the app's CURRENT version. */
  reject(input: { doc: AppDocument; note: string; by: string }): Promise<RemixRejection>;
  /** All rejections recorded for one app, oldest first. */
  rejections(appId: AppId): Promise<RemixRejection[]>;
  /** Remove every rejection for one app (delete path). */
  clear(appId: AppId): Promise<void>;
}

export interface ReviewLifecycleDeps {
  store: StoreAdapter;
  baselines: readonly PinBaseline[] | undefined;
  approvals: InClientApprovalAccess;
  history: Pick<AppHistoryAccess, "documents">;
}

export const createReviewLifecycle = (deps: ReviewLifecycleDeps): ReviewLifecycle => {
  const rejections: RecordStore = deps.store.records(COLLECTION);
  const baselines = (): readonly PinBaseline[] => deps.baselines ?? [];

  const isReviewKind = (doc: AppDocument): boolean =>
    (doc.pins ?? []).some((pin) =>
      baselines().some((baseline) => baseline.slot === pin.slot && baseline.review === true));

  const rejectionsFor = async (appId: AppId): Promise<RemixRejection[]> => {
    const records = await listAllRecords(rejections, { refs: { appId } });
    return records
      .flatMap((record) => {
        const parsed = remixRejectionSchema.safeParse(record.data);
        // A corrupt row is simply not a rejection — same rule as approvals.
        return parsed.success && parsed.data.appId === appId ? [parsed.data] : [];
      })
      .sort((left, right) => left.at.localeCompare(right.at));
  };

  const standingFor = async (appId: AppId, versionHash: string): Promise<ReviewStanding> => {
    const rejection = (await rejectionsFor(appId))
      .filter((candidate) => candidate.versionHash === versionHash)
      .at(-1);
    if (rejection === undefined) return { status: "pending", versionHash };
    return {
      status: "rejected",
      versionHash,
      note: rejection.note,
      by: rejection.by,
      at: rejection.at,
    };
  };

  const serveDocFor = async (current: AppDocument): Promise<AppDocument> => {
    if (!isReviewKind(current)) return current;
    if ((await deps.approvals.verdictFor(current)).granted) return current;
    const approved = new Set((await deps.approvals.list(current.id)).map(({ versionHash }) => versionHash));
    if (approved.size === 0) return current;
    // Newest approved version wins: history is oldest-first. An approved
    // version that fell off the capped history fails closed to the pending
    // state below.
    const snapshots = await deps.history.documents(current.id);
    for (const snapshot of snapshots.reverse()) {
      if (approved.has(appVersionHash(snapshot))) return snapshot;
    }
    return current;
  };

  const venueStateFor = async (doc: AppDocument): Promise<InClientVenueState | undefined> => {
    const base = await deps.approvals.venueStateFor(doc);
    // The kind — and the standing — belong to the CURRENT stored version: the
    // opener may be serving an older approved snapshot whose own pins predate
    // the review-kind fork, and deciding from the served document would
    // silently drop the "sent for review" indicator. A granted serve is the
    // one case where the snapshot's kind can differ, so it re-reads too.
    if (!isReviewKind(doc) && base?.granted !== true) return base;
    const record = await deps.store.records("vendo_apps").get(doc.id);
    const current = record === null ? doc : documentFromRecord(record);
    if (!isReviewKind(current)) return base;
    const currentHash = appVersionHash(current);
    if (base?.granted === true) {
      if (base.versionHash === currentHash) return base;
      return { ...base, review: await standingFor(doc.id, currentHash) };
    }
    // Review-kind never jails: any unapproved state (including the instant
    // vocabulary's version-changed drop-back) becomes pending-review, and the
    // opener withholds every executable source for it.
    return {
      granted: false,
      versionHash: currentHash,
      reason: "pending-review",
      review: await standingFor(doc.id, currentHash),
    };
  };

  return {
    isReviewKind,
    serveDocFor,
    venueStateFor,

    async queue() {
      const entries: ReviewQueueEntry[] = [];
      for (const record of await listAllRecords(deps.store.records("vendo_apps"))) {
        let row;
        try {
          row = rowFromRecord(record);
        } catch {
          continue; // an invalid row cannot be reviewed
        }
        const doc = row.doc;
        // The review-kind slot doubles as the kind test: none → instant-kind.
        const slot = (doc.pins ?? []).find((pin) =>
          baselines().some((baseline) => baseline.slot === pin.slot && baseline.review === true))?.slot;
        if (slot === undefined) continue;
        if ((await deps.approvals.verdictFor(doc)).granted) continue;
        const versionHash = appVersionHash(doc);
        const standing = await standingFor(doc.id, versionHash);
        // A rejected version left the queue; it re-enters when a new version
        // supersedes the rejection.
        if (standing.status === "rejected") continue;
        entries.push({
          appId: doc.id,
          requester: row.subject,
          slot,
          versionHash,
          submittedAt: record.updatedAt,
          // Distinct rejected VERSIONS, not rejection rows: one resubmission
          // per superseded rejection even if legacy rows doubled up.
          resubmissions: new Set((await rejectionsFor(doc.id)).map((rejection) => rejection.versionHash)).size,
          shipDiff: computeShipDiff(doc, baselines()),
        });
      }
      return entries.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
    },

    async reject({ doc, note, by }) {
      // The note is the whole point of a rejection — it is what the user's
      // panel surfaces — so an empty one refuses loudly (the wire's 4xx).
      if (note.trim().length === 0) {
        throw new VendoError("validation", "a rejection requires a note for the user");
      }
      if (!isReviewKind(doc)) {
        throw new VendoError("conflict", `app ${doc.id} is not a review-kind remix`);
      }
      const versionHash = appVersionHash(doc);
      if ((await deps.approvals.verdictFor(doc)).granted) {
        throw new VendoError("conflict", `version ${versionHash} is already approved`);
      }
      // A rejected version already left the queue — a second note for the
      // same version would only inflate the resubmission count.
      if ((await standingFor(doc.id, versionHash)).status === "rejected") {
        throw new VendoError("conflict", `version ${versionHash} is already rejected`);
      }
      const rejection = remixRejectionSchema.parse({
        appId: doc.id,
        versionHash,
        note,
        by,
        at: new Date().toISOString(),
      });
      // The id is deterministic per (app, version), so the duplicate check
      // above being check-then-write racy cannot double-record: concurrent
      // rejections of the same version upsert the SAME row and converge on
      // one note.
      await rejections.put({
        id: `remrej_${sha256Hex(`${rejection.appId}:${versionHash}`)}`,
        data: rejection,
        refs: { appId: rejection.appId },
      });
      return rejection;
    },

    rejections: rejectionsFor,

    async clear(appId) {
      for (const record of await listAllRecords(rejections, { refs: { appId } })) {
        await rejections.delete(record.id);
      }
    },
  };
};
