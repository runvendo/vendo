/**
 * "Show this app in that slot", as ROWS.
 *
 * A placement used to be a string on the app document (`doc.placements`),
 * which meant slot discovery had to list every app the person owned and scan
 * it, a slot could not show a build that had not landed yet (no document, no
 * placement), and eviction was a read-modify-write across other people's rows.
 *
 * The rows live in the GENERIC records collection — like this package's own
 * egress-approval rows (`egress-approval.ts`), and unlike the app-GRANT rows,
 * which earned a dedicated table (`packages/store/src/routing.ts`
 * RESERVED_COLLECTIONS). One adapter interface, so this behaves identically on
 * the local PGlite store, a BYO Postgres, and the Cloud hosted store — none of
 * which shares a schema migration path.
 *
 * `refs` is the queryable key: `subject` is what the erase cascade matches
 * (`vendo_records WHERE refs @> '{"subject": …}'::jsonb` —
 * `packages/store/src/erase.ts`), and `{subject, slot}` is the GIN-indexed pair
 * a slot query reads.
 */
import type { RecordInput, StoreAdapter, VendoRecord } from "@vendoai/core";
import { listAllRecords } from "./persistence.js";

/** The generic collection the rows live in (never a dedicated table). */
export const PLACEMENTS_COLLECTION = "vendo_placements";

export interface PlacementRow {
  slot: string;
  appId: string;
  placedBy: string;
  placedAt: string;
}

export interface PlacementStore {
  get(subject: string, slot: string): Promise<PlacementRow | undefined>;
  put(subject: string, row: PlacementRow): Promise<void>;
  /** Take the slot and report what held it, as ONE decision. */
  place(subject: string, row: PlacementRow): Promise<PlacementRow | undefined>;
  /** Clear the slot only while `appId` still holds it. */
  delete(subject: string, slot: string, appId: string): Promise<void>;
  list(subject: string, slots?: readonly string[]): Promise<PlacementRow[]>;
}

/** The id IS the (subject, slot) pair, so a second place in the same slot
 *  OVERWRITES instead of racing a delete-then-insert, and a get is a primary
 *  key read. Both halves are percent-encoded — `encodeURIComponent` escapes
 *  ":" as %3A — so a ":" inside a subject can never shift the pair. */
const rowId = (subject: string, slot: string): string =>
  `plc:${encodeURIComponent(subject)}:${encodeURIComponent(slot)}`;

const rowOf = (record: VendoRecord): PlacementRow | undefined => {
  const data = record.data as Partial<PlacementRow> | null;
  if (data === null || typeof data !== "object") return undefined;
  const { slot, appId, placedBy, placedAt } = data;
  if (
    typeof slot !== "string" || typeof appId !== "string"
    || typeof placedBy !== "string" || typeof placedAt !== "string"
  ) return undefined;
  return { slot, appId, placedBy, placedAt };
};

export function placementStore(store: StoreAdapter): PlacementStore {
  const rows = store.records(PLACEMENTS_COLLECTION);

  const get = async (subject: string, slot: string): Promise<PlacementRow | undefined> => {
    const record = await rows.get(rowId(subject, slot));
    return record === null ? undefined : rowOf(record);
  };

  const inputFor = (subject: string, row: PlacementRow): RecordInput => ({
    id: rowId(subject, row.slot),
    data: {
      slot: row.slot,
      appId: row.appId,
      placedBy: row.placedBy,
      placedAt: row.placedAt,
    },
    refs: { subject, slot: row.slot },
  });

  return {
    get,

    async put(subject, row) {
      await rows.put(inputFor(subject, row));
    },

    /**
     * The eviction receipt is only true if the read and the write are ONE
     * decision: read-then-put let two places into the same slot both answer
     * "nothing was replaced" while one of them was silently displaced. The
     * generic records collection carries a revision on every adapter Vendo
     * ships, so the loser sees the winner's row and retries against it.
     */
    async place(subject, row) {
      const input = inputFor(subject, row);
      const atomic = rows.atomic;
      if (atomic === undefined) {
        // A BYO adapter with no compare-and-swap keeps the old read-then-write
        // and its old race; there is nothing else to arbitrate on.
        const previous = await get(subject, row.slot);
        await rows.put(input);
        return previous;
      }
      for (;;) {
        const current = await rows.get(input.id);
        if (current === null) {
          if (await atomic.insertIfAbsent(input) !== null) return undefined;
          continue;
        }
        if (current.revision === undefined) throw new Error("placement row is missing its revision");
        if (await atomic.compareAndSwap(input, current.revision) !== null) return rowOf(current);
      }
    },

    /**
     * Scoped to the app the caller named, at the STORE: a stale client whose
     * read said `appId` must never take out the app that replaced it between
     * that read and this write. `claim` compares and deletes in one statement;
     * an adapter without it falls back to the read the caller already did.
     */
    async delete(subject, slot, appId) {
      const id = rowId(subject, slot);
      const record = await rows.get(id);
      if (record === null || rowOf(record)?.appId !== appId) return;
      if (rows.claim !== undefined) {
        await rows.claim({
          id,
          data: record.data,
          ...(record.refs === undefined ? {} : { refs: record.refs }),
        });
        return;
      }
      await rows.delete(id);
    },

    async list(subject, slots) {
      if (slots !== undefined) {
        const found = await Promise.all([...new Set(slots)].map((slot) => get(subject, slot)));
        return found.filter((row): row is PlacementRow => row !== undefined);
      }
      const records = await listAllRecords(rows, { refs: { subject } });
      return records
        .map(rowOf)
        .filter((row): row is PlacementRow => row !== undefined)
        .sort((left, right) => left.slot.localeCompare(right.slot));
    },
  };
}
