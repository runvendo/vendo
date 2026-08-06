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
 * TWO rows per slot, because one row cannot answer both questions at once:
 *
 *   pointer  `plc:<subject>:<slot>`          — WHO holds the slot, and under
 *                                              which token. Never deleted; the
 *                                              only arbitration point, so the
 *                                              eviction receipt is one CAS.
 *   live     `plcv:<subject>:<slot>:<token>` — exists iff THAT placement still
 *                                              holds the slot.
 *
 * The slot is occupied iff the live row the pointer names exists. Splitting
 * them is what makes a clear safe: a clear is `delete(liveId(token))` and
 * nothing else, and a token is never reused, so a stale client's delete can
 * only ever hit its OWN placement — never the app that replaced it. Keyed on
 * the shared (subject, slot) pair alone, that delete lands on whatever now
 * occupies the id, which is exactly the row it must not touch.
 *
 * `refs` is the queryable key on both: `subject` is what the erase cascade
 * matches (`vendo_records WHERE refs @> '{"subject": …}'::jsonb` —
 * `packages/store/src/erase.ts`), and `{subject, slot}` is the GIN-indexed
 * pair a slot query reads.
 */
import type { RecordInput, StoreAdapter, VendoRecord } from "@vendoai/core";
import { listAllRecords } from "./persistence.js";

/** The generic collection the LIVE rows live in (never a dedicated table).
 *  Exactly one row per live placement, which is what the seam readers count. */
export const PLACEMENTS_COLLECTION = "vendo_placements";

/** The pointers, in their own generic collection so the live count above stays
 *  the live count. Neither reserved nor dedicated, so it routes to the same
 *  `vendo_records` table — no migration, and the erase cascade still sweeps it
 *  on `refs.subject`. */
export const PLACEMENT_SLOTS_COLLECTION = "vendo_placement_slots";

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

/** Both halves are percent-encoded — `encodeURIComponent` escapes ":" as %3A —
 *  so a ":" inside a subject can never shift the pair. */
const pointerId = (subject: string, slot: string): string =>
  `plc:${encodeURIComponent(subject)}:${encodeURIComponent(slot)}`;

/** The token is minted per PLACEMENT, so this id names one act of placing
 *  rather than a slot that many acts share. */
const liveId = (subject: string, slot: string, token: string): string =>
  `plcv:${encodeURIComponent(subject)}:${encodeURIComponent(slot)}:${token}`;

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

const tokenOf = (record: VendoRecord): string | undefined => {
  const data = record.data as { token?: unknown } | null;
  if (data === null || typeof data !== "object") return undefined;
  return typeof data.token === "string" ? data.token : undefined;
};

export function placementStore(store: StoreAdapter): PlacementStore {
  const rows = store.records(PLACEMENTS_COLLECTION);
  const pointers = store.records(PLACEMENT_SLOTS_COLLECTION);

  const dataFor = (row: PlacementRow): Record<string, string> => ({
    slot: row.slot,
    appId: row.appId,
    placedBy: row.placedBy,
    placedAt: row.placedAt,
  });

  const pointerInput = (subject: string, row: PlacementRow, token: string): RecordInput => ({
    id: pointerId(subject, row.slot),
    data: { ...dataFor(row), token },
    refs: { subject, slot: row.slot },
  });

  const liveInput = (subject: string, row: PlacementRow, token: string): RecordInput => ({
    id: liveId(subject, row.slot, token),
    data: dataFor(row),
    refs: { subject, slot: row.slot },
  });

  const get = async (subject: string, slot: string): Promise<PlacementRow | undefined> => {
    const pointer = await pointers.get(pointerId(subject, slot));
    const token = pointer === null ? undefined : tokenOf(pointer);
    if (token === undefined) return undefined;
    const live = await rows.get(liveId(subject, slot, token));
    return live === null ? undefined : rowOf(live);
  };

  /**
   * The eviction receipt is only true if the read and the write are ONE
   * decision: read-then-put let two places into the same slot both answer
   * "nothing was replaced" while one of them was silently displaced. The
   * pointer carries a revision on every adapter Vendo ships, so the loser
   * sees the winner's pointer and retries against it.
   */
  const place = async (subject: string, row: PlacementRow): Promise<PlacementRow | undefined> => {
    const token = globalThis.crypto.randomUUID();
    const atomic = pointers.atomic;
    if (atomic === undefined) {
      // A BYO adapter with no compare-and-swap keeps the old read-then-write
      // and its old race; there is nothing else to arbitrate on.
      const previous = await get(subject, row.slot);
      await rows.put(liveInput(subject, row, token));
      await pointers.put(pointerInput(subject, row, token));
      return previous;
    }
    // The live row goes down FIRST and the pointer swings to it second, so the
    // slot never reads empty mid-replace: until the CAS lands every reader
    // still resolves the app that is really there. Losing the CAS means this
    // row was never named by anyone, so it is taken back out before retrying.
    await rows.put(liveInput(subject, row, token));
    for (;;) {
      const current = await pointers.get(pointerId(subject, row.slot));
      const input = pointerInput(subject, row, token);
      if (current === null) {
        if (await atomic.insertIfAbsent(input) === null) continue;
        return undefined;
      }
      if (current.revision === undefined) throw new Error("placement pointer is missing its revision");
      if (await atomic.compareAndSwap(input, current.revision) === null) continue;
      // The slot is ours. Whatever the pointer named before us is strictly
      // older than this placement, so clearing it can never take out a newer
      // one, and it is what the caller is owed as the eviction receipt.
      const displaced = tokenOf(current);
      if (displaced === undefined) return undefined;
      const previous = await rows.get(liveId(subject, row.slot, displaced));
      if (previous === null) return undefined;
      await rows.delete(liveId(subject, row.slot, displaced));
      return rowOf(previous);
    }
  };

  return {
    get,
    place,

    async put(subject, row) {
      await place(subject, row);
    },

    async delete(subject, slot, appId) {
      const pointer = await pointers.get(pointerId(subject, slot));
      if (pointer === null) return;
      const token = tokenOf(pointer);
      if (token === undefined || rowOf(pointer)?.appId !== appId) return;
      // The only mutation, and it names THIS placement's token: a place that
      // lands between the read above and this write installs a new token, so
      // the app that replaced ours is in a row this delete cannot address.
      await rows.delete(liveId(subject, slot, token));
    },

    async list(subject, slots) {
      if (slots !== undefined) {
        const found = await Promise.all([...new Set(slots)].map((slot) => get(subject, slot)));
        return found.filter((row): row is PlacementRow => row !== undefined);
      }
      const [pointerRecords, liveRecords] = await Promise.all([
        listAllRecords(pointers, { refs: { subject } }),
        listAllRecords(rows, { refs: { subject } }),
      ]);
      const live = new Map(liveRecords.map((record) => [record.id, record]));
      const found: PlacementRow[] = [];
      for (const pointer of pointerRecords) {
        const token = tokenOf(pointer);
        const row = rowOf(pointer);
        if (token === undefined || row === undefined) continue;
        const held = live.get(liveId(subject, row.slot, token));
        if (held !== undefined) found.push(rowOf(held) ?? row);
      }
      return found.sort((left, right) => left.slot.localeCompare(right.slot));
    },
  };
}
