import type { RecordQuery, RecordStore, VendoRecord } from "@vendoai/core";
import type { Db } from "./db.js";
import { decodeCursor, encodeCursor, iso, jsonParam, pageLimit, text } from "./helpers/utils.js";

function recordFromRow(row: Record<string, unknown>): VendoRecord {
  const refs = row["refs"] as Record<string, string> | null;
  return {
    id: text(row["id"]),
    data: row["data"],
    ...(refs == null ? {} : { refs }),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

/** 01-core §12 */
export function createRecordStore(db: Db, collection: string): RecordStore {
  return {
    async get(id) {
      const result = await db.query(
        "SELECT id, data, refs, created_at, updated_at FROM vendo_records WHERE collection = $1 AND id = $2",
        [collection, id],
      );
      return result.rows[0] ? recordFromRow(result.rows[0]) : null;
    },
    async put(record) {
      const now = new Date().toISOString();
      const result = await db.query(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5)
         ON CONFLICT (collection, id) DO UPDATE
         SET data = EXCLUDED.data, refs = EXCLUDED.refs, updated_at = EXCLUDED.updated_at
         RETURNING id, data, refs, created_at, updated_at`,
        [collection, record.id, jsonParam(record.data), record.refs === undefined ? null : jsonParam(record.refs), now],
      );
      return recordFromRow(result.rows[0] as Record<string, unknown>);
    },
    async delete(id) {
      await db.query("DELETE FROM vendo_records WHERE collection = $1 AND id = $2", [collection, id]);
    },
    async list(query: RecordQuery = {}) {
      const limit = pageLimit(query.limit);
      const clauses = ["collection = $1"];
      const params: unknown[] = [collection];
      if (query.refs !== undefined) {
        params.push(jsonParam(query.refs));
        clauses.push(`refs @> $${params.length}::jsonb`);
      }
      if (query.ids !== undefined) {
        params.push(query.ids);
        clauses.push(`id = ANY($${params.length}::text[])`);
      }
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor);
        params.push(cursor.c, cursor.i);
        clauses.push(`(created_at, id) > ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `SELECT id, data, refs, created_at, updated_at FROM vendo_records
         WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
        params,
      );
      const rows = result.rows.slice(0, limit).map(recordFromRow);
      const last = rows.at(-1);
      return {
        records: rows,
        ...(result.rows.length > limit && last ? { cursor: encodeCursor(last.createdAt, last.id) } : {}),
      };
    },
  };
}
