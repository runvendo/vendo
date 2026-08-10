/**
 * The host's mounted slots, as ROWS — the registry a surface reports itself
 * into, so anything that offers to build for a slot can name the real ones.
 *
 * A slot exists because a page RENDERS it, and nothing announces when one is
 * taken off a page: a row written once would outlive its surface forever. So
 * every render reports the slot again, refreshing `lastSeen`, and the read
 * filters on it — a slot that stopped rendering ages out of the registry on its
 * own after {@link SLOT_DECAY_MS}.
 *
 * The rows live in the GENERIC records collection, like the placement rows
 * beside them (`placements.ts`): `vendo_slots` is neither reserved nor
 * dedicated (`packages/store/src/routing.ts`), so it routes to `vendo_records`
 * on every adapter with no migration to run.
 *
 * `refs` carries `subject` and nothing else — the key the erase cascade matches
 * (`vendo_records WHERE refs @> '{"subject": …}'::jsonb`, `packages/store/src/
 * erase.ts`), and the only query this surface ever makes.
 */
import { SLOT_DECAY_MS, type RunContext, type StoreAdapter, type VendoRecord } from "@vendoai/core";
import { listAllRecords } from "./persistence.js";

/** The generic collection the slot rows live in (never a dedicated table). */
export const SLOTS_COLLECTION = "vendo_slots";

// The window itself lives in core with the rest of the registry's numbers: the
// client refreshes a still-mounted slot against it, so the two must not drift.
export { SLOT_DECAY_MS };

/** One slot, as the host's surface reports it. */
export interface SlotDescriptor {
  id: string;
  label: string;
}

/** A registered slot, as the registry answers it. */
export interface SlotRecord extends SlotDescriptor {
  lastSeen: string;
}

export interface SlotRegistry {
  /** Idempotent: one row per (subject, slot), refreshed in place. */
  report(input: { slots: readonly SlotDescriptor[] }, ctx: RunContext): Promise<void>;
  /** The caller's own slots inside the decay window, most recently seen first. */
  list(ctx: RunContext): Promise<SlotRecord[]>;
}

/** Both halves are percent-encoded — `encodeURIComponent` escapes ":" as %3A —
 *  so a ":" inside a subject can never shift the pair (placements.ts). */
const rowId = (subject: string, slotId: string): string =>
  `slot:${encodeURIComponent(subject)}:${encodeURIComponent(slotId)}`;

const slotOf = (record: VendoRecord): SlotRecord | undefined => {
  const data = record.data as Partial<SlotRecord> | null;
  if (data === null || typeof data !== "object") return undefined;
  const { id, label, lastSeen } = data;
  if (typeof id !== "string" || typeof label !== "string" || typeof lastSeen !== "string") {
    return undefined;
  }
  return { id, label, lastSeen };
};

export const createSlotRegistry = (store: StoreAdapter): SlotRegistry => {
  const rows = store.records(SLOTS_COLLECTION);

  return {
    async report({ slots }, ctx) {
      const subject = ctx.principal.subject;
      const lastSeen = new Date().toISOString();
      // Plain put, last write wins, no compare-and-swap: two tabs reporting the
      // same slot are reporting the SAME fact, so there is nothing to
      // arbitrate — and a renamed label is meant to overwrite the old one.
      await Promise.all(slots.map(({ id, label }) => rows.put({
        id: rowId(subject, id),
        data: { id, label, lastSeen },
        refs: { subject },
      })));
    },

    async list(ctx) {
      const found = await listAllRecords(rows, { refs: { subject: ctx.principal.subject } });
      const floor = Date.now() - SLOT_DECAY_MS;
      // Sorted HERE, not by the store: the generic collection orders by
      // created_at — when the slot was FIRST seen, which is the opposite of
      // what this answer is about. ISO-8601 UTC strings compare chronologically.
      return found
        .map(slotOf)
        .filter((slot): slot is SlotRecord =>
          slot !== undefined && Date.parse(slot.lastSeen) >= floor)
        .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
    },
  };
};
