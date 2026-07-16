import {
  VendoError,
  type AppDocument,
  type ApprovalRequest,
  type AtomicRecordStore,
  type AuditEvent,
  type Json,
  type PermissionGrant,
  type RecordQuery,
  type RecordStore,
  type VendoRecord,
} from "@vendoai/core";
import type { Db } from "./db.js";
import { createRecordStore, requireRevision, type DedicatedRecordTable } from "./records.js";
import { isEphemeralApp, isEphemeralSubject, overlayFor, registerEphemeralSubject, snapshot, stateKey } from "./ephemeral.js";
import {
  appFromRow,
  approvalFromRow,
  grantFromRow,
  putAppRow,
  putApprovalRow,
  putAuditRow,
  putGrantRow,
  putRunRow,
  putStateRow,
  putThreadRow,
  runFromRow,
  stateRowFromRow,
  threadFromRow,
} from "./helpers/rows.js";
import type { AppRow, ApprovalRow, EphemeralStateRow, RunRow, ThreadRow } from "./helpers/types.js";
import { decodeCursor, encodeCursor, pageLimit } from "./helpers/utils.js";
import type { VendoStore } from "./store.js";
import {
  invalid,
  parseAppData,
  parseApprovalData,
  parseAuditEvent,
  parsePermissionGrant,
  parseRunData,
  parseThreadData,
  requireJson,
  requireMatchingId,
  requireRecordId,
  type ApprovalData,
  type AppData,
  type RunData,
  type ThreadData,
} from "./validate.js";

export const RESERVED_COLLECTIONS = [
  "vendo_grants",
  "vendo_approvals",
  "vendo_audit",
  "vendo_threads",
  "vendo_runs",
  "vendo_apps",
  "vendo_state",
] as const;

export const DEDICATED_RECORD_COLLECTIONS = ["vendo_mcp_clients", "vendo_mcp_grants"] as const;

export type ReservedCollection = typeof RESERVED_COLLECTIONS[number];

interface RoutedConfig {
  table: ReservedCollection;
  select: string;
  /** Optional lighter projection for `list` (get/point-reads still use `select`).
   *  vendo_threads uses it to avoid transferring the full messages array per row. */
  listSelect?: string;
  /** 02-store §2: vendo_audit is append-only through this door — `delete` is
   *  refused outright; rows are erased only via the store erase API (02 §5). */
  appendOnly?: true;
  cursorColumn: string;
  refs: Readonly<Record<string, string>>;
  fromDb(row: Record<string, unknown>): VendoRecord;
  overlayRecords(): VendoRecord[];
  put(record: { id: string; data: Json; refs?: Record<string, string> }): Promise<VendoRecord>;
  deleteOverlay(id: string): boolean;
  /** Optional additive capability (01 §12): guarded writes for collections whose
   *  table carries a revision counter. vendo_threads provides it (ENG-310). */
  atomic?: AtomicRecordStore;
}

function refs(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function grantRecord(grant: PermissionGrant): VendoRecord {
  return {
    id: grant.id,
    data: grant,
    refs: refs({ subject: grant.subject, tool: grant.tool, app_id: grant.appId }),
    createdAt: grant.grantedAt,
    updatedAt: grant.revokedAt ?? grant.grantedAt,
  };
}

function approvalRecord(row: ApprovalRow): VendoRecord {
  const data: ApprovalData = {
    request: row.request,
    status: row.status,
    ...(row.decidedAt === undefined ? {} : { decidedAt: row.decidedAt }),
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    ...(row.consumedAt === undefined ? {} : { consumedAt: row.consumedAt }),
  };
  return {
    id: row.id,
    data,
    refs: { subject: row.subject, status: row.status },
    createdAt: row.request.createdAt,
    updatedAt: row.consumedAt ?? row.decidedAt ?? row.request.createdAt,
  };
}

function auditRecord(event: AuditEvent): VendoRecord {
  return {
    id: event.id,
    data: event,
    refs: refs({
      subject: event.principal.subject,
      kind: event.kind,
      app_id: event.appId,
      tool: event.tool,
    }),
    createdAt: event.at,
    updatedAt: event.at,
  };
}

function threadRecord(row: ThreadRow): VendoRecord {
  const data: ThreadData = {
    subject: row.subject,
    messages: row.messages,
    ...(row.title === undefined || row.title === null ? {} : { title: row.title }),
  };
  return {
    id: row.id,
    data,
    refs: { subject: row.subject },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Present when the row carries the write counter (01 §12: opaque token when
    // atomic is present); the messages-less listSelect projection omits it.
    ...(row.revision === undefined ? {} : { revision: row.revision }),
  };
}

function runRecord(row: RunRow): VendoRecord {
  const { id, ...data } = row;
  return {
    id,
    data,
    refs: { app_id: row.appId, status: row.status },
    createdAt: row.startedAt,
    updatedAt: row.finishedAt ?? row.startedAt,
  };
}

function appRecord(row: AppRow): VendoRecord {
  const data: AppData = { subject: row.subject, enabled: row.enabled, doc: row.doc };
  return {
    id: row.id,
    data,
    // trigger_kind mirrors the persisted generated column (schema.ts) so the DB and the
    // in-memory overlay agree on the same filterable ref (the automations tick / emit query it).
    refs: refs({ subject: row.subject, trigger_kind: row.doc.trigger?.on.kind }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function stateRecord(row: EphemeralStateRow): VendoRecord {
  return {
    id: `${row.appId}:${row.subject}`,
    data: row.data,
    refs: { app_id: row.appId, subject: row.subject },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * apps writes state through `records("vendo_state")` with id `${appId}:${subject}`.
 * App ids are `app_...` and never contain a colon, so the first colon splits id into
 * its app_id and subject (subjects may themselves contain colons).
 *
 * The colon-free app-id shape is REQUIRED, not assumed: without it `<appId>:<subject>`
 * is not uniquely decodable — (app_a:b, c) and (app_a, b:c) would both encode to
 * "app_a:b:c" and collide on read/write/delete. The apps runtime mints colon-free
 * ids; this enforces it at the door so a doctored id can never target another row.
 */
const APP_ID_SEGMENT = /^app_[^:]+$/;

function splitStateId(id: string): { appId: string; subject: string } {
  const colon = id.indexOf(":");
  if (colon === -1) invalid(`vendo_state record id must be "<appId>:<subject>": ${id}`);
  const appId = id.slice(0, colon);
  if (!APP_ID_SEGMENT.test(appId)) {
    invalid(`vendo_state record id must start with a colon-free app id ("app_..."): ${id}`);
  }
  const subject = id.slice(colon + 1);
  // An empty subject ("app_x:") would route a state row to no principal — reject it
  // (the apps runtime always writes a non-empty subject).
  if (subject === "") {
    invalid(`vendo_state record id must have a non-empty subject after the colon: ${id}`);
  }
  return { appId, subject };
}

function matchesRecord(record: VendoRecord, query: RecordQuery, cursor?: { c: string; i: string }): boolean {
  if (query.ids !== undefined && !query.ids.includes(record.id)) return false;
  if (query.refs !== undefined) {
    for (const [key, value] of Object.entries(query.refs)) {
      if (record.refs?.[key] !== value) return false;
    }
  }
  return cursor === undefined
    || record.createdAt < cursor.c
    || (record.createdAt === cursor.c && record.id < cursor.i);
}

function createTableRecordStore(db: Db, config: RoutedConfig): RecordStore {
  return {
    async get(id) {
      requireRecordId(id);
      const memory = config.overlayRecords().find((record) => record.id === id);
      if (memory) return memory;
      const result = await db.query(`${config.select} WHERE id = $1`, [id]);
      return result.rows[0] ? config.fromDb(result.rows[0]) : null;
    },
    async put(record) {
      requireRecordId(record.id);
      // Reserved collections derive refs from typed columns; caller refs never participate in writes.
      return snapshot(await config.put(record));
    },
    async delete(id) {
      requireRecordId(id);
      if (config.appendOnly === true) {
        throw new VendoError(
          "blocked",
          `${config.table} is append-only; rows are erased only via the store erase API (02-store §5)`,
        );
      }
      if (config.deleteOverlay(id)) return;
      await db.query(`DELETE FROM ${config.table} WHERE id = $1`, [id]);
    },
    async list(query: RecordQuery = {}) {
      const limit = pageLimit(query.limit);
      if (query.refs !== undefined) {
        for (const key of Object.keys(query.refs)) {
          if (config.refs[key] === undefined) invalid(`Unknown ${config.table} ref key: ${key}`);
        }
      }
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const params: unknown[] = [];
      const clauses: string[] = [];
      for (const [key, value] of Object.entries(query.refs ?? {})) {
        params.push(value);
        clauses.push(`${config.refs[key]} = $${params.length}`);
      }
      if (query.ids !== undefined) {
        params.push(query.ids);
        clauses.push(`id = ANY($${params.length}::text[])`);
      }
      if (cursor !== undefined) {
        params.push(cursor.c, cursor.i);
        clauses.push(`(${config.cursorColumn}, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `${config.listSelect ?? config.select}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY ${config.cursorColumn} DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const allMemory = config.overlayRecords();
      const memoryIds = new Set(allMemory.map((record) => record.id));
      const records = [
        ...result.rows.map(config.fromDb).filter((record) => !memoryIds.has(record.id)),
        ...allMemory.filter((record) => matchesRecord(record, query, cursor)),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const page = records.slice(0, limit);
      const last = page.at(-1);
      const hasMore = records.length > limit || result.rows.length > limit;
      return {
        records: page,
        ...(hasMore && last ? { cursor: encodeCursor(last.createdAt, last.id) } : {}),
      };
    },
    ...(config.atomic === undefined ? {} : { atomic: config.atomic }),
  };
}

function configFor(store: VendoStore, db: Db, collection: ReservedCollection): RoutedConfig {
  const overlay = overlayFor(store);
  switch (collection) {
    case "vendo_grants":
      return {
        table: collection,
        select: "SELECT * FROM vendo_grants",
        cursorColumn: "granted_at",
        refs: { subject: "subject", tool: "tool", app_id: "app_id" },
        fromDb: (row) => grantRecord(grantFromRow(row)),
        overlayRecords: () => [...overlay.grants.values()].map((grant) => grantRecord(snapshot(grant))),
        async put(record) {
          const grant = parsePermissionGrant(record.data);
          requireMatchingId(record.id, grant.id, "permission grant id");
          if (isEphemeralSubject(store, grant.subject)) {
            // Mirror the SQL door's cross-subject refusal (02 §2): a prior
            // overlay grant owned by another subject is never flipped.
            const prior = overlay.grants.get(grant.id);
            if (prior !== undefined && prior.subject !== grant.subject) {
              throw new VendoError("conflict", `grant ${grant.id} belongs to another subject`);
            }
            overlay.grants.set(grant.id, snapshot(grant));
          } else {
            await putGrantRow(db, grant);
          }
          return grantRecord(grant);
        },
        deleteOverlay: (id) => overlay.grants.delete(id),
      };
    case "vendo_approvals":
      return {
        table: collection,
        select: "SELECT * FROM vendo_approvals",
        cursorColumn: "created_at",
        refs: { subject: "subject", status: "status" },
        fromDb: (row) => approvalRecord(approvalFromRow(row)),
        overlayRecords: () => [...overlay.approvals.values()].map((row) => approvalRecord(snapshot(row))),
        async put(record) {
          const data = parseApprovalData(record.data, record.id);
          const row: ApprovalRow = {
            id: data.request.id,
            subject: data.request.ctx.principal.subject,
            request: data.request,
            status: data.status,
            ...(data.decidedAt === undefined ? {} : { decidedAt: data.decidedAt }),
            ...(data.sessionId === undefined ? {} : { sessionId: data.sessionId }),
            ...(data.consumedAt === undefined ? {} : { consumedAt: data.consumedAt }),
            createdAt: data.request.createdAt,
          };
          if (data.request.ctx.principal.ephemeral === true) {
            registerEphemeralSubject(store, row.subject);
            overlay.approvals.set(row.id, snapshot(row));
          } else {
            await putApprovalRow(db, row);
          }
          return approvalRecord(row);
        },
        deleteOverlay: (id) => overlay.approvals.delete(id),
      };
    case "vendo_audit":
      return {
        table: collection,
        select: "SELECT * FROM vendo_audit",
        appendOnly: true,
        cursorColumn: "at",
        refs: { subject: "subject", kind: "kind", app_id: "app_id", tool: "tool" },
        fromDb: (row) => auditRecord(row["event"] as AuditEvent),
        overlayRecords: () => [...overlay.audit.values()].map((event) => auditRecord(snapshot(event))),
        async put(record) {
          const event = parseAuditEvent(record.data);
          requireMatchingId(record.id, event.id, "audit event id");
          if (event.principal.ephemeral === true) {
            registerEphemeralSubject(store, event.principal.subject);
            // Mirror the SQL door's append-only refusal (02 §2): an existing
            // overlay row is never replaced.
            if (overlay.audit.has(event.id)) {
              throw new VendoError("conflict", `audit event ${event.id} already exists (vendo_audit is append-only)`);
            }
            overlay.audit.set(event.id, snapshot(event));
          } else {
            await putAuditRow(db, event);
          }
          return auditRecord(event);
        },
        // Unreachable through the routed door (appendOnly refuses first); the
        // erase API clears overlay audit rows directly (02 §5).
        deleteOverlay: () => false,
      };
    case "vendo_threads":
      return {
        table: collection,
        select: "SELECT * FROM vendo_threads",
        // Listing derives only a title + timestamps; skip the (potentially large) messages
        // column once a row carries a stored title. Legacy rows (title still NULL, written
        // before the column existed) keep returning messages so the title stays derivable.
        listSelect: `SELECT id, subject, title,
           CASE WHEN title IS NULL THEN messages ELSE '[]'::jsonb END AS messages,
           created_at, updated_at FROM vendo_threads`,
        cursorColumn: "created_at",
        refs: { subject: "subject" },
        fromDb: (row) => threadRecord(threadFromRow(row)),
        overlayRecords: () => [...overlay.threads.values()].map((row) => threadRecord(snapshot(row))),
        async put(record) {
          const data = parseThreadData(record.data, record.id);
          const now = new Date().toISOString();
          let row: ThreadRow;
          if (isEphemeralSubject(store, data.subject)) {
            const prior = overlay.threads.get(record.id);
            // Mirror the SQL door's cross-subject refusal (03 §5): the bare id is
            // shared, so a prior overlay row owned by another subject is never
            // flipped — it is a conflict, same as putThreadRow's guarded upsert.
            if (prior !== undefined && prior.subject !== data.subject) {
              throw new VendoError("conflict", `thread ${record.id} belongs to another subject`);
            }
            row = {
              id: record.id,
              subject: data.subject,
              messages: data.messages,
              ...(data.title === undefined ? {} : { title: data.title }),
              createdAt: prior?.createdAt ?? now,
              updatedAt: now,
              revision: String(BigInt(prior?.revision ?? "0") + 1n),
            };
            overlay.threads.set(record.id, snapshot(row));
          } else {
            row = await putThreadRow(db, { id: record.id, ...data }, now);
          }
          return threadRecord(row);
        },
        deleteOverlay: (id) => overlay.threads.delete(id),
        // ENG-310: guarded writes (01 §12) backed by the vendo_threads revision
        // counter, so a concurrent-turn persist can read-merge-write without
        // last-write-wins clobbering. Both verbs keep the same cross-subject
        // refusal as put: a foreign-subject write NEVER lands (it just loses —
        // insertIfAbsent finds the id taken, compareAndSwap's guarded WHERE /
        // overlay subject check fails — and returns null).
        atomic: {
          async insertIfAbsent(record) {
            requireRecordId(record.id);
            const data = parseThreadData(record.data, record.id);
            const now = new Date().toISOString();
            if (isEphemeralSubject(store, data.subject)) {
              if (overlay.threads.has(record.id)) return null;
              const row: ThreadRow = {
                id: record.id,
                subject: data.subject,
                messages: data.messages,
                ...(data.title === undefined ? {} : { title: data.title }),
                createdAt: now,
                updatedAt: now,
                revision: "1",
              };
              overlay.threads.set(record.id, snapshot(row));
              return threadRecord(row);
            }
            const result = await db.query(
              `INSERT INTO vendo_threads (id, subject, messages, title, created_at, updated_at, revision)
               VALUES ($1, $2, $3::jsonb, $4, $5, $5, 1)
               ON CONFLICT (id) DO NOTHING
               RETURNING id, subject, messages, title, created_at, updated_at, revision`,
              [record.id, data.subject, JSON.stringify(data.messages), data.title ?? null, now],
            );
            return result.rows[0]
              ? threadRecord(threadFromRow(result.rows[0] as Record<string, unknown>))
              : null;
          },
          async compareAndSwap(record, expectedRevision) {
            requireRecordId(record.id);
            requireRevision(expectedRevision);
            const data = parseThreadData(record.data, record.id);
            const now = new Date().toISOString();
            if (isEphemeralSubject(store, data.subject)) {
              const prior = overlay.threads.get(record.id);
              if (prior === undefined || prior.subject !== data.subject
                || prior.revision !== expectedRevision) {
                return null;
              }
              const row: ThreadRow = {
                id: record.id,
                subject: data.subject,
                messages: data.messages,
                ...(data.title === undefined ? {} : { title: data.title }),
                createdAt: prior.createdAt,
                updatedAt: now,
                revision: String(BigInt(expectedRevision) + 1n),
              };
              overlay.threads.set(record.id, snapshot(row));
              return threadRecord(row);
            }
            const result = await db.query(
              `UPDATE vendo_threads
               SET messages = $3::jsonb, title = $4, updated_at = $5, revision = revision + 1
               WHERE id = $1 AND subject = $2 AND revision = $6::bigint
               RETURNING id, subject, messages, title, created_at, updated_at, revision`,
              [record.id, data.subject, JSON.stringify(data.messages), data.title ?? null, now, expectedRevision],
            );
            return result.rows[0]
              ? threadRecord(threadFromRow(result.rows[0] as Record<string, unknown>))
              : null;
          },
        },
      };
    case "vendo_runs":
      return {
        table: collection,
        select: "SELECT * FROM vendo_runs",
        cursorColumn: "started_at",
        refs: { app_id: "app_id", status: "status" },
        fromDb: (row) => runRecord(runFromRow(row)),
        overlayRecords: () => [...overlay.runs.values()].map((row) => runRecord(snapshot(row))),
        async put(record) {
          const data = parseRunData(record.data, record.id);
          const row: RunRow = { id: record.id, ...data };
          if (await isEphemeralApp(store, db, data.appId)) overlay.runs.set(row.id, snapshot(row));
          else await putRunRow(db, row);
          return runRecord(row);
        },
        deleteOverlay: (id) => overlay.runs.delete(id),
      };
    case "vendo_apps":
      return {
        table: collection,
        select: "SELECT * FROM vendo_apps",
        cursorColumn: "created_at",
        refs: { subject: "subject", trigger_kind: "trigger_kind" },
        fromDb: (row) => appRecord(appFromRow(row)),
        overlayRecords: () => [...overlay.apps.values()].map((row) => appRecord(snapshot(row))),
        async put(record) {
          const data = parseAppData(record.data, record.id);
          const now = new Date().toISOString();
          let row: AppRow;
          if (isEphemeralSubject(store, data.subject)) {
            const prior = overlay.apps.get(record.id);
            // Mirror the SQL door's cross-subject refusal (02 §2): a prior
            // overlay app owned by another subject is never flipped.
            if (prior !== undefined && prior.subject !== data.subject) {
              throw new VendoError("conflict", `app ${record.id} belongs to another subject`);
            }
            row = {
              id: record.id,
              subject: data.subject,
              enabled: data.enabled,
              doc: data.doc,
              createdAt: prior?.createdAt ?? now,
              updatedAt: now,
            };
            overlay.apps.set(record.id, snapshot(row));
          } else {
            row = await putAppRow(db, { id: record.id, ...data }, now);
          }
          return appRecord(row);
        },
        deleteOverlay: (id) => overlay.apps.delete(id),
      };
    case "vendo_state":
      return {
        table: collection,
        // `id` is the generated (app_id || ':' || subject) column — a real,
        // indexed column, so point lookups and id filters no longer seq-scan.
        select: "SELECT id, app_id, subject, data, created_at, updated_at FROM vendo_state",
        // Page on the STABLE created_at (like every other collection), not the
        // mutable updated_at — a mid-sweep update must never skip an unvisited row.
        cursorColumn: "created_at",
        refs: { app_id: "app_id", subject: "subject" },
        fromDb: (row) => stateRecord(stateRowFromRow(row)),
        overlayRecords: () => [...overlay.states.values()].map((row) => stateRecord(snapshot(row))),
        async put(record) {
          const { appId, subject } = splitStateId(record.id);
          const data = requireJson(record.data, "state data");
          const now = new Date().toISOString();
          // Mirrors vendo_apps/vendo_threads: ephemerality is decided by the subject
          // registry (the owning app registers the subject before state is written).
          if (isEphemeralSubject(store, subject)) {
            const key = stateKey(subject, appId);
            const prior = overlay.states.get(key);
            const row: EphemeralStateRow = {
              appId,
              subject,
              data,
              createdAt: prior?.createdAt ?? now,
              updatedAt: now,
            };
            overlay.states.set(key, snapshot(row));
            return stateRecord(row);
          }
          // Shared persistent write path with stateStore.put (helpers/rows).
          return stateRecord(await putStateRow(db, { appId, subject, data }, now));
        },
        deleteOverlay: (id) => {
          const { appId, subject } = splitStateId(id);
          return overlay.states.delete(stateKey(subject, appId));
        },
      };
  }
}

export function createReservedRecordStore(
  store: VendoStore,
  db: Db,
  collection: string,
): RecordStore | undefined {
  if ((DEDICATED_RECORD_COLLECTIONS as readonly string[]).includes(collection)) {
    return createRecordStore(store, db, collection, collection as DedicatedRecordTable);
  }
  if (!(RESERVED_COLLECTIONS as readonly string[]).includes(collection)) return undefined;
  return createTableRecordStore(db, configFor(store, db, collection as ReservedCollection));
}
