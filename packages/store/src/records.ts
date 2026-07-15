import {
  canonicalJson,
  VendoError,
  type AtomicRecordStore,
  type RecordInput,
  type RecordQuery,
  type RecordStore,
  type VendoRecord,
} from "@vendoai/core";
import type { Db } from "./db.js";
import { isEphemeralApp, overlayFor, snapshot } from "./ephemeral.js";
import { decodeCursor, encodeCursor, iso, jsonParam, pageLimit, text } from "./helpers/utils.js";
import type { VendoStore } from "./store.js";

export type DedicatedRecordTable = "vendo_mcp_clients" | "vendo_mcp_grants";

function recordFromRow(row: Record<string, unknown>): VendoRecord {
  const refs = row["refs"] as Record<string, string> | null;
  const revision = row["revision"];
  if (revision !== undefined && !(typeof revision === "string" || typeof revision === "number" || typeof revision === "bigint")) {
    throw new Error("Expected database revision");
  }
  return {
    id: text(row["id"]),
    data: row["data"],
    ...(refs == null ? {} : { refs }),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
    ...(revision === undefined ? {} : { revision: String(revision) }),
  };
}

function sameRecordValue(
  current: VendoRecord,
  expected: Pick<VendoRecord, "data" | "refs">,
): boolean {
  return canonicalJson(current.data) === canonicalJson(expected.data)
    && canonicalJson(current.refs ?? null) === canonicalJson(expected.refs ?? null);
}

function requireRevision(value: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new VendoError("validation", "malformed record revision");
}

type CompareExpectation =
  | {
    kind: "revision";
    id: string;
    revision: string;
    value?: Pick<VendoRecord, "data" | "refs">;
  }
  | { kind: "value"; record: RecordInput };

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

  const getRecord = async (id: string): Promise<VendoRecord | null> => {
    if (await isEphemeral()) {
      const row = overlayFor(store).records.get(collection)?.get(id);
      return row ? snapshot(row) : null;
    }
    const result = usesCollection
      ? await db.query(
        "SELECT id, data, refs, created_at, updated_at, revision FROM vendo_records WHERE collection = $1 AND id = $2",
        [collection, id],
      )
      : await db.query(
        `SELECT id, data, refs, created_at, updated_at FROM ${table} WHERE id = $1`,
        [id],
      );
    return result.rows[0] ? recordFromRow(result.rows[0]) : null;
  };

  const compareAndMutate = async (
    expected: CompareExpectation,
    replacement?: RecordInput,
  ): Promise<VendoRecord | null> => {
    const expectedId = expected.kind === "revision" ? expected.id : expected.record.id;
    if (replacement !== undefined && replacement.id !== expectedId) {
      throw new Error("Record comparison and replacement ids must match");
    }
    if (expected.kind === "revision") requireRevision(expected.revision);

    if (await isEphemeral()) {
      const records = ephemeralRecords();
      const prior = records.get(expectedId);
      const matches = prior !== undefined && (expected.kind === "revision"
        ? prior.revision === expected.revision
          && (expected.value === undefined || sameRecordValue(prior, expected.value))
        : sameRecordValue(prior, expected.record));
      if (!matches || prior === undefined) return null;
      if (replacement === undefined) {
        records.delete(expectedId);
        return snapshot(prior);
      }
      const stored: VendoRecord = {
        id: replacement.id,
        data: replacement.data,
        ...(replacement.refs === undefined ? {} : { refs: replacement.refs }),
        createdAt: prior.createdAt,
        updatedAt: new Date().toISOString(),
        revision: String(BigInt(prior.revision ?? "0") + 1n),
      };
      records.set(expectedId, snapshot(stored));
      return snapshot(stored);
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (usesCollection) {
      if (expected.kind !== "revision") throw new Error("Generic record comparisons require a revision");
      params.push(collection, expected.id, expected.revision);
      clauses.push("collection = $1", "id = $2", "revision = $3::bigint");
      if (expected.value !== undefined) {
        params.push(jsonParam(expected.value.data));
        clauses.push(`data = $${params.length}::jsonb`);
        params.push(expected.value.refs === undefined ? null : jsonParam(expected.value.refs));
        clauses.push(`refs IS NOT DISTINCT FROM $${params.length}::jsonb`);
      }
    } else {
      if (expected.kind !== "value") throw new Error("Dedicated record comparisons require an expected value");
      params.push(
        expected.record.id,
        jsonParam(expected.record.data),
        expected.record.refs === undefined ? null : jsonParam(expected.record.refs),
      );
      clauses.push("id = $1", "data = $2::jsonb", "refs IS NOT DISTINCT FROM $3::jsonb");
    }

    const returning = `id, data, refs, created_at, updated_at${usesCollection ? ", revision" : ""}`;
    if (replacement === undefined) {
      const result = await db.query(
        `DELETE FROM ${table} WHERE ${clauses.join(" AND ")} RETURNING ${returning}`,
        params,
      );
      return result.rows[0] ? recordFromRow(result.rows[0]) : null;
    }

    params.push(jsonParam(replacement.data));
    const dataParam = params.length;
    params.push(replacement.refs === undefined ? null : jsonParam(replacement.refs));
    const refsParam = params.length;
    params.push(new Date().toISOString());
    const updatedAtParam = params.length;
    const result = await db.query(
      `UPDATE ${table}
       SET data = $${dataParam}::jsonb, refs = $${refsParam}::jsonb, updated_at = $${updatedAtParam}${usesCollection ? ", revision = revision + 1" : ""}
       WHERE ${clauses.join(" AND ")}
       RETURNING ${returning}`,
      params,
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : null;
  };

  const atomic: AtomicRecordStore = {
    async insertIfAbsent(record) {
      const now = new Date().toISOString();
      if (await isEphemeral()) {
        const records = ephemeralRecords();
        if (records.has(record.id)) return null;
        const stored: VendoRecord = {
          id: record.id,
          data: record.data,
          ...(record.refs === undefined ? {} : { refs: record.refs }),
          createdAt: now,
          updatedAt: now,
          revision: "1",
        };
        records.set(record.id, snapshot(stored));
        return snapshot(stored);
      }
      const result = await db.query(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5, 1)
         ON CONFLICT (collection, id) DO NOTHING
         RETURNING id, data, refs, created_at, updated_at, revision`,
        [collection, record.id, jsonParam(record.data), record.refs === undefined ? null : jsonParam(record.refs), now],
      );
      return result.rows[0] ? recordFromRow(result.rows[0]) : null;
    },
    async compareAndSwap(record, expectedRevision) {
      return await compareAndMutate(
        { kind: "revision", id: record.id, revision: expectedRevision },
        record,
      );
    },
  };

  return {
    get: getRecord,
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
          revision: String(BigInt(prior?.revision ?? "0") + 1n),
        };
        records.set(record.id, snapshot(stored));
        return snapshot(stored);
      }
      const result = usesCollection
        ? await db.query(
          `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5, 1)
           ON CONFLICT (collection, id) DO UPDATE
           SET data = EXCLUDED.data, refs = EXCLUDED.refs, updated_at = EXCLUDED.updated_at,
               revision = vendo_records.revision + 1
           RETURNING id, data, refs, created_at, updated_at, revision`,
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
    async claim(expected, replacement) {
      const current = await getRecord(expected.id);
      if (current === null || !sameRecordValue(current, expected)) return false;
      let expectation: CompareExpectation;
      if (usesCollection) {
        if (current.revision === undefined) throw new Error("Generic record is missing its revision");
        expectation = {
          kind: "revision",
          id: expected.id,
          revision: current.revision,
          value: expected,
        };
      } else {
        expectation = { kind: "value", record: expected };
      }
      const next = replacement === undefined
        ? undefined
        : {
          id: expected.id,
          data: replacement.data,
          ...(replacement.refs === undefined ? {} : { refs: replacement.refs }),
        };
      return await compareAndMutate(expectation, next) !== null;
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
        `SELECT id, data, refs, created_at, updated_at${usesCollection ? ", revision" : ""} FROM ${table}
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
    ...(usesCollection ? { atomic } : {}),
  };
}
