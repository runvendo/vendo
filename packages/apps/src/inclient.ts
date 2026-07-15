import type { AppDocument, AppId, RecordStore, StoreAdapter } from "@vendoai/core";
import { inClientApprovalSchema, type InClientApproval } from "./pins.js";
import { appVersionHash } from "./version-hash.js";

/**
 * 06-apps §9 — the server-side verdict for the trust axis. UI runs in the
 * sandboxed iframe by default; ONLY a verdict whose `granted` is true (the
 * current version's content hash matches a stored approval) lets the client
 * mount app UI in the host page. Any hash mismatch drops back to the iframe.
 */
export type InClientVerdict =
  | { granted: true; versionHash: string; approval: InClientApproval }
  | { granted: false; versionHash: string; reason: "no-approval" | "version-changed" };

/**
 * The additive in-client venue state the opener rides inside the tree payload
 * (like `furnishings` — UIPayload is forward-compatible; the frozen
 * OpenSurface shape stays intact). The client's renderer treats a missing
 * field as the default: jailed.
 */
export type InClientVenueState =
  | { granted: true; versionHash: string; approvedBy: string; at: string }
  | { granted: false; versionHash: string; reason: "version-changed" };

export interface InClientApprovalAccess {
  /** All stored approvals for one app — an audit trail, one per approved version. */
  list(appId: AppId): Promise<InClientApproval[]>;
  /** Persist one approval record (OSS injection seam; Cloud's console mints in production). */
  record(approval: InClientApproval): Promise<InClientApproval>;
  /** Verify the CURRENT version's content hash against the stored approvals. */
  verdictFor(doc: AppDocument): Promise<InClientVerdict>;
  /** The payload field for `open()` — undefined when there is nothing to say (default jail). */
  venueStateFor(doc: AppDocument): Promise<InClientVenueState | undefined>;
  /** Remove every approval for one app (delete path). */
  clear(appId: AppId): Promise<void>;
}

const COLLECTION = "vendo_inclient_approvals";

const allRecords = async (records: RecordStore, appId: AppId) => {
  const found = [];
  let cursor: string | undefined;
  do {
    const page = await records.list(cursor === undefined
      ? { refs: { appId } }
      : { refs: { appId }, cursor });
    found.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

/** 06-apps §9 — hash-pinned in-client approvals over the store seam. */
export const createInClientApprovals = (store: StoreAdapter): InClientApprovalAccess => {
  const records = store.records(COLLECTION);

  const list = async (appId: AppId): Promise<InClientApproval[]> => {
    const approvals: InClientApproval[] = [];
    for (const record of await allRecords(records, appId)) {
      const parsed = inClientApprovalSchema.safeParse(record.data);
      // A corrupt row can never grant a mount; it is simply not an approval.
      if (parsed.success && parsed.data.appId === appId) approvals.push(parsed.data);
    }
    return approvals.sort((left, right) => left.at.localeCompare(right.at));
  };

  const verdictFor = async (doc: AppDocument): Promise<InClientVerdict> => {
    const versionHash = appVersionHash(doc);
    const approvals = await list(doc.id);
    const approval = [...approvals].reverse()
      .find((candidate) => candidate.versionHash === versionHash);
    if (approval !== undefined) return { granted: true, versionHash, approval };
    return {
      granted: false,
      versionHash,
      reason: approvals.length > 0 ? "version-changed" : "no-approval",
    };
  };

  return {
    list,
    async record(approval) {
      const validated = inClientApprovalSchema.parse(approval);
      await records.put({
        id: `incl_${globalThis.crypto.randomUUID()}`,
        data: validated,
        refs: { appId: validated.appId },
      });
      return validated;
    },
    verdictFor,
    async venueStateFor(doc) {
      const verdict = await verdictFor(doc);
      if (verdict.granted) {
        return {
          granted: true,
          versionHash: verdict.versionHash,
          approvedBy: verdict.approval.approvedBy,
          at: verdict.approval.at,
        };
      }
      // "version-changed" must be LOUD in the client (the drop-back notice);
      // "no-approval" is the universal default and rides as nothing at all.
      if (verdict.reason === "version-changed") {
        return { granted: false, versionHash: verdict.versionHash, reason: "version-changed" };
      }
      return undefined;
    },
    async clear(appId) {
      for (const record of await allRecords(records, appId)) {
        await records.delete(record.id);
      }
    },
  };
};
