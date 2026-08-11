import { assertEngineCollection } from "./engine-collections.js";
import { VendoError } from "./errors.js";
import type { RecordStore, StoreAdapter, StoreOps } from "./store.js";

/** The `engine` family over a bare {@link StoreAdapter}.
 *
 *  Every block that owns Vendo drawers (automations, guard, apps) reads them
 *  through `ops.engine.*`, but `selectStoreOps` answers `undefined` for a store
 *  with neither its own ops surface nor a SQL handle — and a host constructing a
 *  block DIRECTLY passes only a `StoreAdapter`. This is that store's engine
 *  family: the allowlist gate in front, the adapter's own record door behind.
 *  It lives in core because none of those blocks may import `@vendoai/store`.
 *
 *  `records()` is called per verb and never cached: an adapter is free to mint a
 *  fresh handle each time, and fixtures that wrap one to inject a failure depend
 *  on it. */
export function engineOverAdapter(store: StoreAdapter): StoreOps["engine"] {
  const door = (collection: string): RecordStore => {
    assertEngineCollection(collection);
    return store.records(collection);
  };
  return {
    get: async (collection, id) => await door(collection).get(id),
    put: async (collection, record) => await door(collection).put(record),
    delete: async (collection, id) => {
      await door(collection).delete(id);
    },
    list: async (collection, query) => await door(collection).list(query),
    claim: async (collection, expected, replacement) => {
      const records = door(collection);
      if (records.claim === undefined) {
        throw new VendoError("not-implemented", `${collection} does not support claim`);
      }
      return await records.claim(expected, replacement);
    },
    /** `RecordStore.atomic` is OPTIONAL (02-store §4), so an adapter without it
     *  gets the check-then-put every caller used to hand-roll behind an
     *  `atomic === undefined` branch. It is not atomic and does not pretend to
     *  be — it is what those call sites already did, in one place, so moving a
     *  block onto this family does not quietly turn a working BYO adapter into
     *  a `not-implemented`. An adapter that HAS the capability always gets the
     *  real one. */
    insertIfAbsent: async (collection, record) => {
      const records = door(collection);
      if (records.atomic !== undefined) return await records.atomic.insertIfAbsent(record);
      if (await records.get(record.id) !== null) return null;
      return await records.put(record);
    },
    /** Same degradation, and it is narrower than it looks. A revision is the
     *  token this compares against, and `VendoRecord.revision` is documented as
     *  present only when the store exposes `atomic` — so on a door that honors
     *  that, no caller can ever hold a revision and this path is unreachable.
     *  It is reached only by a door that hands out revisions it cannot enforce,
     *  where the token means nothing and there is genuinely nothing to compare.
     *  Last write wins, which is what the blocks did in their own
     *  `atomic === undefined` branches before they moved onto this family. */
    compareAndSwap: async (collection, record, expectedRevision) => {
      const records = door(collection);
      if (records.atomic === undefined) return await records.put(record);
      return await records.atomic.compareAndSwap(record, expectedRevision);
    },
  };
}
