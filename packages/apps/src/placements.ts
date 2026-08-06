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
 *                                              which token. The only
 *                                              arbitration point, so the
 *                                              eviction receipt is one CAS.
 *   live     `plcv:<subject>:<slot>:<token>` — exists iff THAT placement still
 *                                              holds the slot.
 *
 * The slot is occupied iff the live row the pointer names exists. Splitting
 * them is what makes a clear safe: a clear deletes the token'd live row, and a
 * token is never reused, so a stale client's delete can only ever hit its OWN
 * placement — never the app that replaced it. Keyed on the shared
 * (subject, slot) pair alone, that delete lands on whatever now occupies the
 * id, which is exactly the row it must not touch.
 *
 * A clear takes the pointer with it, but ONLY while the pointer still names
 * the token being cleared: an emptied slot must cost no row, and the token
 * check is what keeps that from evicting whoever took the slot in between.
 *
 * `refs` is the queryable key on both: `subject` is what the erase cascade
 * matches (`vendo_records WHERE refs @> '{"subject": …}'::jsonb` —
 * `packages/store/src/erase.ts`), `{subject, slot}` is the GIN-indexed pair a
 * slot query reads, and `app_id` is what app deletion sweeps on (the same ref
 * name `egress-approval.ts` clears an app by) — a shared app is placed by
 * people its owner cannot enumerate.
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
  /** Clear every placement of one app, whoever holds it (app-deletion cleanup). */
  clearForApp(appId: string): Promise<void>;
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

  const refsFor = (subject: string, row: PlacementRow): Record<string, string> =>
    ({ subject, slot: row.slot, app_id: row.appId });

  const pointerInput = (subject: string, row: PlacementRow, token: string): RecordInput => ({
    id: pointerId(subject, row.slot),
    data: { ...dataFor(row), token },
    refs: refsFor(subject, row),
  });

  const liveInput = (subject: string, row: PlacementRow, token: string): RecordInput => ({
    id: liveId(subject, row.slot, token),
    data: dataFor(row),
    refs: refsFor(subject, row),
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
  const swingPointer = async (
    subject: string,
    row: PlacementRow,
    token: string,
  ): Promise<PlacementRow | undefined> => {
    const atomic = pointers.atomic;
    if (atomic === undefined) {
      // A BYO adapter with no compare-and-swap keeps the old read-then-write
      // and its old race; there is nothing else to arbitrate on.
      const previous = await get(subject, row.slot);
      await pointers.put(pointerInput(subject, row, token));
      return previous;
    }
    for (;;) {
      const current = await pointers.get(pointerId(subject, row.slot));
      const input = pointerInput(subject, row, token);
      if (current === null) {
        if (await atomic.insertIfAbsent(input) === null) continue;
        return undefined;
      }
      if (current.revision === undefined) throw new Error("placement pointer is missing its revision");
      // Losing the CAS retries under the SAME token, so the live row already
      // down is the one the next attempt names; there is nothing to collect.
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

  const place = async (subject: string, row: PlacementRow): Promise<PlacementRow | undefined> => {
    const token = globalThis.crypto.randomUUID();
    // The live row goes down FIRST and the pointer swings to it second, so the
    // slot never reads empty mid-replace: until the pointer lands every reader
    // still resolves the app that is really there. The cost is that until then
    // nothing names this row, so a swing that throws has to take it back out —
    // otherwise every retry strands one more row nobody reads or collects.
    await rows.put(liveInput(subject, row, token));
    try {
      return await swingPointer(subject, row, token);
    } catch (error) {
      await rows.delete(liveId(subject, row.slot, token));
      throw error;
    }
  };

  const remove = async (subject: string, slot: string, appId: string): Promise<void> => {
    const pointer = await pointers.get(pointerId(subject, slot));
    if (pointer === null) return;
    const token = tokenOf(pointer);
    if (token === undefined || rowOf(pointer)?.appId !== appId) return;
    // Names THIS placement's token: a place that lands between the read above
    // and this write installs a new token, so the app that replaced ours is in
    // a row this delete cannot address.
    await rows.delete(liveId(subject, slot, token));
    // The pointer is shared by every placement into this slot, so it goes only
    // while it still names OUR token — re-read, because a place may have taken
    // the slot since. Removing it rather than leaving it vacant is what lets a
    // deleted app leave nothing behind: nothing else in the tree ever collects
    // a pointer, and only a full subject erase would reach it.
    const current = await pointers.get(pointerId(subject, slot));
    if (current === null || tokenOf(current) !== token) return;
    // The token check has to ride the WRITE, not merely precede it. A delete
    // keyed on the slot alone lands on whatever the pointer names when it
    // arrives, so a place landing in the gap above has its brand-new pointer
    // deleted out from under it — its live row orphaned and the slot the person
    // just filled reading empty. `claim` with no replacement is the store
    // contract's compare-and-delete, keyed on the row this read saw.
    if (pointers.claim === undefined) {
      // A BYO adapter with no compare-and-delete keeps the read-then-delete and
      // its race, the same concession `swingPointer` makes without CAS.
      await pointers.delete(pointerId(subject, slot));
      return;
    }
    await pointers.claim({
      id: current.id,
      data: current.data,
      ...(current.refs === undefined ? {} : { refs: current.refs }),
    });
  };

  return {
    get,
    place,
    delete: remove,

    async put(subject, row) {
      await place(subject, row);
    },

    /** By `app_id`, not by subject: a shared app is placed by people its owner
     *  cannot enumerate, and a row left behind reads as a build that never
     *  landed — a failure card standing on somebody else's page. */
    async clearForApp(appId) {
      for (const pointer of await listAllRecords(pointers, { refs: { app_id: appId } })) {
        const subject = pointer.refs?.subject;
        const slot = rowOf(pointer)?.slot;
        if (subject === undefined || slot === undefined) continue;
        await remove(subject, slot, appId);
      }
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
