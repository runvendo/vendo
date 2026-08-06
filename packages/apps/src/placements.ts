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
import type { StoreAdapter, VendoRecord } from "@vendoai/core";
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
  delete(subject: string, slot: string): Promise<void>;
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

  return {
    get,

    async put(subject, row) {
      await rows.put({
        id: rowId(subject, row.slot),
        data: {
          slot: row.slot,
          appId: row.appId,
          placedBy: row.placedBy,
          placedAt: row.placedAt,
        },
        refs: { subject, slot: row.slot },
      });
    },

    async delete(subject, slot) {
      await rows.delete(rowId(subject, slot));
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
