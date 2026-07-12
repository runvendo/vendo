import type { RecordQuery, RecordStore, VendoRecord } from "@vendoai/core";
import type { Db } from "./db.js";
import { isEphemeralApp, overlayFor, snapshot } from "./ephemeral.js";
import { decodeCursor, encodeCursor, iso, jsonParam, pageLimit, text } from "./helpers/utils.js";
import type { VendoStore } from "./store.js";

export type DedicatedRecordTable = "vendo_mcp_clients" | "vendo_mcp_grants";

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
export function createRecordStore(
  store: VendoStore,
  db: Db,
  collection: string,
  dedicatedTable?: DedicatedRecordTable,
): RecordStore {
  const table = dedicatedTable ?? "vendo_records";
  const usesCollection = dedicatedTable === undefined;
  const appId = /^app:([^:]+):/.exec(collection)?.[1];
  const ephemeralRecords = (): Map<string, VendoRecord> => {
    const records = overlayFor(store).records;
    let collectionRecords = records.get(collection);
    if (!collectionRecords) {
      collectionRecords = new Map();
      records.set(collection, collectionRecords);
    }
    return collectionRecords;
  };
  const isEphemeral = async (): Promise<boolean> => appId !== undefined && isEphemeralApp(store, db, appId);

  return {
    async get(id) {
      if (await isEphemeral()) {
        const row = overlayFor(store).records.get(collection)?.get(id);
        return row ? snapshot(row) : null;
      }
      const result = usesCollection
        ? await db.query(
          "SELECT id, data, refs, created_at, updated_at FROM vendo_records WHERE collection = $1 AND id = $2",
          [collection, id],
        )
        : await db.query(
          `SELECT id, data, refs, created_at, updated_at FROM ${table} WHERE id = $1`,
          [id],
        );
      return result.rows[0] ? recordFromRow(result.rows[0]) : null;
    },
    async put(record) {
      const now = new Date().toISOString();
      if (await isEphemeral()) {
        const records = ephemeralRecords();
        const prior = records.get(record.id);
        const stored: VendoRecord = {
          id: record.id,
          data: record.data,
          ...(record.refs === undefined ? {} : { refs: record.refs }),
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        records.set(record.id, snapshot(stored));
        return snapshot(stored);
      }
      const result = usesCollection
        ? await db.query(
          `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5)
           ON CONFLICT (collection, id) DO UPDATE
           SET data = EXCLUDED.data, refs = EXCLUDED.refs, updated_at = EXCLUDED.updated_at
           RETURNING id, data, refs, created_at, updated_at`,
          [collection, record.id, jsonParam(record.data), record.refs === undefined ? null : jsonParam(record.refs), now],
        )
        : await db.query(
          `INSERT INTO ${table} (id, data, refs, created_at, updated_at)
           VALUES ($1, $2::jsonb, $3::jsonb, $4, $4)
           ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data, refs = EXCLUDED.refs, updated_at = EXCLUDED.updated_at
           RETURNING id, data, refs, created_at, updated_at`,
          [record.id, jsonParam(record.data), record.refs === undefined ? null : jsonParam(record.refs), now],
        );
      return recordFromRow(result.rows[0] as Record<string, unknown>);
    },
    async delete(id) {
      if (await isEphemeral()) {
        overlayFor(store).records.get(collection)?.delete(id);
        return;
      }
      if (usesCollection) {
        await db.query("DELETE FROM vendo_records WHERE collection = $1 AND id = $2", [collection, id]);
      } else {
        await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      }
    },
    async list(query: RecordQuery = {}) {
      const limit = pageLimit(query.limit);
      if (await isEphemeral()) {
        const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
        const matching = [...(overlayFor(store).records.get(collection)?.values() ?? [])]
          .filter((record) => query.ids === undefined || query.ids.includes(record.id))
          .filter((record) => query.refs === undefined || Object.entries(query.refs)
            .every(([key, value]) => record.refs?.[key] === value))
          .filter((record) => cursor === undefined || record.createdAt < cursor.c
            || (record.createdAt === cursor.c && record.id < cursor.i))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const records = matching.slice(0, limit).map(snapshot);
        const last = records.at(-1);
        return {
          records,
          ...(matching.length > limit && last ? { cursor: encodeCursor(last.createdAt, last.id) } : {}),
        };
      }
      const clauses = usesCollection ? ["collection = $1"] : [];
      const params: unknown[] = usesCollection ? [collection] : [];
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
        clauses.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `SELECT id, data, refs, created_at, updated_at FROM ${table}
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
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
