import { PGlite } from "@electric-sql/pglite";
import {
  approvalRequestSchema,
  auditEventSchema,
  isoDateTimeSchema,
  permissionGrantSchema,
  VendoError,
} from "@vendoai/core";
import type {
  BlobStore,
  PermissionGrant,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  VendoRecord,
} from "@vendoai/core";
import { z } from "zod";

/** Mirrors the store lane's routed-put validation (DESIGN.md addendum 1). */
const approvalDataSchema = z
  .object({
    request: approvalRequestSchema,
    status: z.enum(["pending", "approved", "denied"]),
    decidedAt: isoDateTimeSchema.optional(),
    sessionId: z.string().optional(),
    consumedAt: isoDateTimeSchema.optional(),
  })
  .passthrough();

function validateRoutedPut(
  collection: ReservedCollection,
  record: Pick<VendoRecord, "id" | "data" | "refs">,
): void {
  const schema =
    collection === "vendo_grants"
      ? permissionGrantSchema
      : collection === "vendo_approvals"
        ? approvalDataSchema
        : auditEventSchema;
  const parsed = schema.safeParse(record.data);
  if (!parsed.success) {
    throw new VendoError("validation", `malformed ${collection} data: ${parsed.error.message}`);
  }
  const embeddedId =
    collection === "vendo_approvals"
      ? (record.data as { request: { id: string } }).request.id
      : (record.data as { id: string }).id;
  if (embeddedId !== record.id) {
    throw new VendoError(
      "validation",
      `${collection} embedded id ${embeddedId} does not match record id ${record.id}`,
    );
  }
}

type ReservedCollection = "vendo_grants" | "vendo_approvals" | "vendo_audit";

const RESERVED = new Set<string>(["vendo_grants", "vendo_approvals", "vendo_audit"]);

function json(value: unknown): string {
  return JSON.stringify(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function cursorOffset(cursor?: string): number {
  return Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
}

class SqlBlobStore implements BlobStore {
  readonly #entries = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void> {
    this.#entries.set(key, {
      bytes: bytes.slice(),
      ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
    });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    const entry = this.#entries.get(key);
    return entry ? { ...entry, bytes: entry.bytes.slice() } : null;
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

export class PGliteStore implements StoreAdapter {
  readonly db = new PGlite();
  readonly #recordStores = new Map<string, RecordStore>();
  readonly #blobStores = new Map<string, BlobStore>();

  async ensureSchema(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS vendo_grants(
        id text primary key,
        subject text not null,
        tool text not null,
        descriptor_hash text,
        scope jsonb,
        duration text,
        context_key text,
        app_id text,
        source text,
        granted_at timestamptz,
        revoked_at timestamptz,
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      CREATE TABLE IF NOT EXISTS vendo_approvals(
        id text primary key,
        subject text not null,
        request jsonb not null,
        status text not null,
        session_id text,
        decided_at timestamptz,
        consumed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      CREATE TABLE IF NOT EXISTS vendo_audit(
        id text primary key,
        at timestamptz not null,
        kind text not null,
        subject text not null,
        venue text,
        presence text,
        app_id text,
        tool text,
        event jsonb not null
      );
      CREATE TABLE IF NOT EXISTS vendo_records(
        collection text not null,
        id text not null,
        data jsonb not null,
        refs jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        revision bigint not null default 1,
        primary key(collection, id)
      );
    `);
  }

  records(collection: string): RecordStore {
    let store = this.#recordStores.get(collection);
    if (!store) {
      store = RESERVED.has(collection)
        ? new ReservedSqlRecordStore(this.db, collection as ReservedCollection)
        : new GenericSqlRecordStore(this.db, collection);
      this.#recordStores.set(collection, store);
    }
    return store;
  }

  blobs(namespace: string): BlobStore {
    let store = this.#blobStores.get(namespace);
    if (!store) {
      store = new SqlBlobStore();
      this.#blobStores.set(namespace, store);
    }
    return store;
  }

  query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.db.query<T>(sql, params);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

class ReservedSqlRecordStore implements RecordStore {
  constructor(
    private readonly db: PGlite,
    private readonly collection: ReservedCollection,
  ) {}

  async get(id: string): Promise<VendoRecord | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${this.collection} WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord> {
    validateRoutedPut(this.collection, record);
    const now = new Date().toISOString();
    if (this.collection === "vendo_grants") {
      const grant = record.data as PermissionGrant;
      await this.db.query(
        `INSERT INTO vendo_grants
          (id, subject, tool, descriptor_hash, scope, duration, context_key, app_id, source,
           granted_at, revoked_at, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         ON CONFLICT (id) DO UPDATE SET
          subject=EXCLUDED.subject, tool=EXCLUDED.tool, descriptor_hash=EXCLUDED.descriptor_hash,
          scope=EXCLUDED.scope, duration=EXCLUDED.duration, context_key=EXCLUDED.context_key,
          app_id=EXCLUDED.app_id, source=EXCLUDED.source, granted_at=EXCLUDED.granted_at,
          revoked_at=EXCLUDED.revoked_at, expires_at=EXCLUDED.expires_at, updated_at=EXCLUDED.updated_at`,
        [
          grant.id,
          grant.subject,
          grant.tool,
          grant.descriptorHash,
          json(grant.scope),
          grant.duration,
          grant.contextKey ?? null,
          grant.appId ?? null,
          grant.source,
          grant.grantedAt,
          grant.revokedAt ?? null,
          grant.expiresAt ?? null,
          now,
        ],
      );
    } else if (this.collection === "vendo_approvals") {
      const data = record.data as {
        request: { id: string; ctx: { principal: { subject: string } } };
        status: string;
        sessionId: string;
        decidedAt?: string;
        consumedAt?: string;
      };
      await this.db.query(
        `INSERT INTO vendo_approvals
          (id, subject, request, status, session_id, decided_at, consumed_at, created_at, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (id) DO UPDATE SET
          subject=EXCLUDED.subject, request=EXCLUDED.request, status=EXCLUDED.status,
          session_id=EXCLUDED.session_id, decided_at=EXCLUDED.decided_at,
          consumed_at=EXCLUDED.consumed_at, updated_at=EXCLUDED.updated_at`,
        [
          record.id,
          data.request.ctx.principal.subject,
          json(data.request),
          data.status,
          data.sessionId,
          data.decidedAt ?? null,
          data.consumedAt ?? null,
          now,
        ],
      );
    } else {
      const event = record.data as {
        id: string;
        at: string;
        kind: string;
        principal: { subject: string };
        venue?: string;
        presence?: string;
        appId?: string;
        tool?: string;
      };
      await this.db.query(
        `INSERT INTO vendo_audit (id, at, kind, subject, venue, presence, app_id, tool, event)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
          at=EXCLUDED.at, kind=EXCLUDED.kind, subject=EXCLUDED.subject, venue=EXCLUDED.venue,
          presence=EXCLUDED.presence, app_id=EXCLUDED.app_id, tool=EXCLUDED.tool, event=EXCLUDED.event`,
        [
          event.id,
          event.at,
          event.kind,
          event.principal.subject,
          event.venue ?? null,
          event.presence ?? null,
          event.appId ?? null,
          event.tool ?? null,
          json(event),
        ],
      );
    }
    const stored = await this.get(record.id);
    if (!stored) throw new Error(`failed to persist ${this.collection}/${record.id}`);
    return stored;
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM ${this.collection} WHERE id = $1`, [id]);
  }

  async list(query: RecordQuery = {}): Promise<{ records: VendoRecord[]; cursor?: string }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.ids) {
      if (query.ids.length === 0) return { records: [] };
      clauses.push(`id IN (${query.ids.map((id) => add(id)).join(",")})`);
    }
    const refColumns: Record<ReservedCollection, Record<string, string>> = {
      vendo_grants: { subject: "subject", tool: "tool", app_id: "app_id" },
      vendo_approvals: { subject: "subject", status: "status" },
      vendo_audit: { subject: "subject", kind: "kind", app_id: "app_id", tool: "tool" },
    };
    for (const [key, value] of Object.entries(query.refs ?? {})) {
      const column = refColumns[this.collection][key];
      if (!column) {
        throw new VendoError(
          "validation",
          `refs key ${key} is not queryable on routed collection ${this.collection}`,
        );
      }
      clauses.push(`${column} = ${add(value)}`);
    }
    const offset = cursorOffset(query.cursor);
    const requestedLimit = query.limit ?? 1_000_000;
    const orderColumn = this.collection === "vendo_audit" ? "at" : "created_at";
    params.push(requestedLimit + 1, offset);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${this.collection}
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY ${orderColumn} DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const hasMore = rows.rows.length > requestedLimit;
    const records = rows.rows.slice(0, requestedLimit).map((row) => this.toRecord(row));
    return {
      records,
      ...(hasMore ? { cursor: String(offset + records.length) } : {}),
    };
  }

  private toRecord(row: Record<string, unknown>): VendoRecord {
    if (this.collection === "vendo_grants") {
      const data: PermissionGrant = {
        id: String(row.id),
        subject: String(row.subject),
        tool: String(row.tool),
        descriptorHash: String(row.descriptor_hash),
        scope: row.scope as PermissionGrant["scope"],
        duration: row.duration as PermissionGrant["duration"],
        ...(row.context_key == null ? {} : { contextKey: String(row.context_key) }),
        ...(row.app_id == null ? {} : { appId: String(row.app_id) }),
        source: row.source as PermissionGrant["source"],
        grantedAt: iso(row.granted_at),
        ...(row.revoked_at == null ? {} : { revokedAt: iso(row.revoked_at) }),
        ...(row.expires_at == null ? {} : { expiresAt: iso(row.expires_at) }),
      };
      return {
        id: data.id,
        data,
        refs: {
          subject: data.subject,
          tool: data.tool,
          ...(data.appId === undefined ? {} : { app_id: data.appId }),
        },
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
    }
    if (this.collection === "vendo_approvals") {
      const request = row.request as { ctx: { principal: { subject: string } } };
      return {
        id: String(row.id),
        data: {
          request,
          status: String(row.status),
          sessionId: String(row.session_id),
          ...(row.decided_at == null ? {} : { decidedAt: iso(row.decided_at) }),
          ...(row.consumed_at == null ? {} : { consumedAt: iso(row.consumed_at) }),
        },
        refs: { subject: request.ctx.principal.subject, status: String(row.status) },
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
    }
    const event = row.event;
    return {
      id: String(row.id),
      data: event,
      refs: {
        subject: String(row.subject),
        kind: String(row.kind),
        ...(row.app_id == null ? {} : { app_id: String(row.app_id) }),
        ...(row.tool == null ? {} : { tool: String(row.tool) }),
      },
      createdAt: iso(row.at),
      updatedAt: iso(row.at),
    };
  }
}

class GenericSqlRecordStore implements RecordStore {
  constructor(
    private readonly db: PGlite,
    private readonly collection: string,
  ) {}

  async get(id: string): Promise<VendoRecord | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM vendo_records WHERE collection = $1 AND id = $2",
      [this.collection, id],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord> {
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$5,1)
       ON CONFLICT (collection, id) DO UPDATE SET
        data=EXCLUDED.data, refs=EXCLUDED.refs, updated_at=EXCLUDED.updated_at,
        revision=vendo_records.revision + 1`,
      [this.collection, record.id, json(record.data), json(record.refs ?? null), now],
    );
    const stored = await this.get(record.id);
    if (!stored) throw new Error(`failed to persist ${this.collection}/${record.id}`);
    return stored;
  }

  /** Mirrors the store lane's generic-table atomic capability (02-store §4):
   *  each verb is one statement, so exactly one concurrent claimant wins. */
  readonly atomic = {
    insertIfAbsent: async (
      record: Pick<VendoRecord, "id" | "data" | "refs">,
    ): Promise<VendoRecord | null> => {
      const now = new Date().toISOString();
      const result = await this.db.query<Record<string, unknown>>(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$5,1)
         ON CONFLICT (collection, id) DO NOTHING
         RETURNING *`,
        [this.collection, record.id, json(record.data), json(record.refs ?? null), now],
      );
      const row = result.rows[0];
      return row ? this.toRecord(row) : null;
    },
    compareAndSwap: async (
      record: Pick<VendoRecord, "id" | "data" | "refs">,
      expectedRevision: string,
    ): Promise<VendoRecord | null> => {
      const now = new Date().toISOString();
      const result = await this.db.query<Record<string, unknown>>(
        `UPDATE vendo_records
         SET data = $3::jsonb, refs = $4::jsonb, updated_at = $5, revision = revision + 1
         WHERE collection = $1 AND id = $2 AND revision = $6::bigint
         RETURNING *`,
        [this.collection, record.id, json(record.data), json(record.refs ?? null), now, expectedRevision],
      );
      const row = result.rows[0];
      return row ? this.toRecord(row) : null;
    },
  };

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM vendo_records WHERE collection = $1 AND id = $2", [
      this.collection,
      id,
    ]);
  }

  async list(query: RecordQuery = {}): Promise<{ records: VendoRecord[]; cursor?: string }> {
    const all = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM vendo_records WHERE collection = $1 ORDER BY created_at DESC, id DESC",
      [this.collection],
    );
    const matching = all.rows
      .map((row) => this.toRecord(row))
      .filter((record) => !query.ids || query.ids.includes(record.id))
      .filter((record) =>
        Object.entries(query.refs ?? {}).every(([key, value]) => record.refs?.[key] === value),
      );
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? matching.length;
    const records = matching.slice(offset, offset + limit);
    const nextOffset = offset + records.length;
    return {
      records,
      ...(nextOffset < matching.length ? { cursor: String(nextOffset) } : {}),
    };
  }

  private toRecord(row: Record<string, unknown>): VendoRecord {
    return {
      id: String(row.id),
      data: row.data,
      ...(row.refs == null ? {} : { refs: row.refs as Record<string, string> }),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.revision == null ? {} : { revision: String(row.revision) }),
    };
  }
}

export async function createPGliteStore(): Promise<PGliteStore> {
  const store = new PGliteStore();
  await store.ensureSchema();
  return store;
}
