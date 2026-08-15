import { collectionKind, type CollectionFootprint } from "@vendoai/core";
// Type-only — erased at compile time, so this module stays engine-free.
import type { Db } from "./db-postgres.js";
import { text } from "./helpers/utils.js";
import { DEDICATED_RECORD_COLLECTIONS, RESERVED_COLLECTIONS } from "./routing.js";

/** Every collection that owns a table of its own name, from the two frozen
 *  routing constants — never from anything a caller said, because these names
 *  are interpolated into SQL. */
const PER_TABLE_COLLECTIONS = [...RESERVED_COLLECTIONS, ...DEDICATED_RECORD_COLLECTIONS];

/** The tables one collection's row content actually lives in. `vendo_threads`
 *  is two: the transcript moved to `vendo_thread_messages` in v6 (schema.ts), so
 *  counting only the header row would report the fattest drawer in the store as
 *  a few hundred bytes per conversation. */
const tablesOf = (collection: string): readonly string[] =>
  collection === "vendo_threads" ? ["vendo_threads", "vendo_thread_messages"] : [collection];

/** `pg_column_size(row)` summed per collection — row CONTENT, the unit
 *  `CollectionFootprint.bytes` promises, and the same unit on both sides so the
 *  two halves of the answer are comparable with each other. Deliberately NOT
 *  `pg_total_relation_size`: most collections share `vendo_records`, so a
 *  per-collection relation size does not exist to report. */
const PER_TABLE_SQL = PER_TABLE_COLLECTIONS.map((collection) =>
  `SELECT '${collection}' AS collection, (${tablesOf(collection)
    .map((table) => `coalesce((SELECT sum(pg_column_size(t.*)) FROM ${table} t), 0)`)
    .join(" + ")})::bigint AS bytes`).join("\n UNION ALL ");

/** What this store is holding, per collection (01 §12 `footprint`). Two reads:
 *  the generic table, which groups itself (and so covers every appData
 *  collection that exists without anyone enumerating them), and the collections
 *  that own a table. Empty collections are omitted, and the answer is sorted, so
 *  two footprints of the same store are diffable. */
export async function collectionFootprints(db: Db): Promise<CollectionFootprint[]> {
  const generic = await db.query(
    "SELECT collection, sum(pg_column_size(r.*))::bigint AS bytes FROM vendo_records r GROUP BY collection",
  );
  const perTable = await db.query(PER_TABLE_SQL);
  const measured: CollectionFootprint[] = [];
  for (const row of [...generic.rows, ...perTable.rows]) {
    const bytes = Number(row["bytes"]);
    if (bytes === 0) continue;
    const collection = text(row["collection"]);
    measured.push({ collection, kind: collectionKind(collection), bytes });
  }
  return measured.sort((a, b) => (a.collection < b.collection ? -1 : 1));
}
