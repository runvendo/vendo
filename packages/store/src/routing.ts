import {
  TRIGGER_KIND_REF_KEYS,
  triggerKindRefs,
  VendoError,
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
  duplicateThreadMessageId,
  putThreadRow,
  replaceThreadMessages,
  runFromRow,
  stateRowFromRow,
  THREAD_MESSAGES_AGGREGATE,
  threadFromRow,
} from "./helpers/rows.js";
import type { AppRow, ApprovalRow, RunRow, StateRow, ThreadRow } from "./helpers/types.js";
import { cursorMs, decodeCursor, encodeCursor, iso, pageLimit, text } from "./helpers/utils.js";
import {
  invalid,
  parseAppData,
  parseAppGrantData,
  parseApprovalData,
  parseAuditEvent,
  parseEffectData,
  parsePermissionGrant,
  parseRunData,
  parseThreadData,
  requireJson,
  requireMatchingId,
  requireRecordId,
  type ApprovalData,
  type AppData,
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
  "vendo_effects",
  "vendo_app_grants",
] as const;

export const DEDICATED_RECORD_COLLECTIONS = [
  "vendo_mcp_clients",
  "vendo_mcp_grants",
  "vendo_knowledge_docs",
  "vendo_knowledge_chunks",
] as const;

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
  /** Optional id-shape validation applied before delete (vendo_state enforces
   *  its `<appId>:<subject>` grammar so a doctored id can't target anything). */
  validateId?(id: string): void;
  put(record: { id: string; data: unknown; refs?: Record<string, string> }): Promise<VendoRecord>;
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
    ...(row.deniedBy === undefined ? {} : { deniedBy: row.deniedBy }),
    ...(row.voidedAt === undefined ? {} : { voidedAt: row.voidedAt }),
  };
  return {
    id: row.id,
    data,
    refs: { subject: row.subject, status: row.status, call: row.request.call.id },
    createdAt: row.request.createdAt,
    updatedAt: row.voidedAt ?? row.consumedAt ?? row.decidedAt ?? row.request.createdAt,
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

export function threadRecord(row: ThreadRow): VendoRecord {
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
    // The per-kind trigger refs mirror the persisted generated columns
    // (schema.ts) so the automations tick / emit query can filter on them. One
    // key per kind because an app has a LIST of triggers and a ref matches by
    // equality; `triggerKindRefs` is core's single definition of both.
    refs: { ...refs({ subject: row.subject }), ...triggerKindRefs(row.doc.triggers) },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Present when the row carries the write counter (01 §12: opaque token
    // when atomic is present) — Wave 7's lifecycle/schedule-claim arbitration.
    ...(row.revision === undefined ? {} : { revision: row.revision }),
  };
}

function effectRecord(row: Record<string, unknown>): VendoRecord {
  const subject = text(row["subject"]);
  const at = iso(row["at"]);
  return {
    id: text(row["id"]),
    data: { subject, outcome: row["outcome"] as Json, at },
    refs: { subject },
    createdAt: at,
    updatedAt: at,
  };
}

/** The single vendo_effects write: insert-once, null when the key already exists. */
async function insertEffect(
  db: Db,
  record: { id: string; data: unknown },
): Promise<VendoRecord | null> {
  const { subject, outcome } = parseEffectData(record.data, record.id);
  const result = await db.query(
    `INSERT INTO vendo_effects (key, subject, outcome) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (key) DO NOTHING
     RETURNING key AS id, subject, outcome, at`,
    [record.id, subject, JSON.stringify(outcome)],
  );
  return result.rows[0] ? effectRecord(result.rows[0]) : null;
}

function appGrantRecord(row: Record<string, unknown>): VendoRecord {
  const at = iso(row["created_at"]);
  const appId = text(row["app_id"]);
  const orgId = text(row["org_id"]);
  const principal = text(row["principal"]);
  const level = text(row["level"]);
  return {
    id: text(row["id"]),
    data: { appId, orgId, principal, level, createdBy: text(row["created_by"]) },
    refs: { app_id: appId, org_id: orgId, principal, level },
    createdAt: at,
    updatedAt: at,
  };
}

function stateRecord(row: StateRow): VendoRecord {
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

function createTableRecordStore(db: Db, config: RoutedConfig): RecordStore {
  return {
    async get(id) {
      requireRecordId(id);
      const result = await db.query(`${config.select} WHERE id = $1`, [id]);
      return result.rows[0] ? config.fromDb(result.rows[0]) : null;
    },
    async put(record) {
      requireRecordId(record.id);
      // Reserved collections derive refs from typed columns; caller refs never participate in writes.
      return await config.put(record);
    },
    async delete(id) {
      requireRecordId(id);
      if (config.appendOnly === true) {
        throw new VendoError(
          "blocked",
          `${config.table} is append-only; rows are erased only via the store erase API (02-store §5)`,
        );
      }
      config.validateId?.(id);
      await db.query(`DELETE FROM ${config.table} WHERE id = $1`, [id]);
    },
    async list(query: RecordQuery = {}) {
      const limit = pageLimit(query.limit);
      if (query.refs !== undefined) {
        for (const key of Object.keys(query.refs)) {
          if (config.refs[key] === undefined) invalid(`Unknown ${config.table} ref key: ${key}`);
        }
      }
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
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor);
        params.push(cursor.c, cursor.i);
        clauses.push(`(${cursorMs(config.cursorColumn)}, id) < (${cursorMs(`$${params.length - 1}::timestamptz`)}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `${config.listSelect ?? config.select}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY ${cursorMs(config.cursorColumn)} DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const records = result.rows.slice(0, limit).map(config.fromDb);
      const last = records.at(-1);
      return {
        records,
        ...(result.rows.length > limit && last ? { cursor: encodeCursor(last.createdAt, last.id) } : {}),
      };
    },
    ...(config.atomic === undefined ? {} : { atomic: config.atomic }),
  };
}

function configFor(db: Db, collection: ReservedCollection): RoutedConfig {
  switch (collection) {
    case "vendo_grants":
      return {
        table: collection,
        select: "SELECT * FROM vendo_grants",
        cursorColumn: "granted_at",
        refs: { subject: "subject", tool: "tool", app_id: "app_id" },
        fromDb: (row) => grantRecord(grantFromRow(row)),
        async put(record) {
          const grant = parsePermissionGrant(record.data);
          requireMatchingId(record.id, grant.id, "permission grant id");
          // The guarded upsert refuses cross-subject flips (02 §2).
          await putGrantRow(db, grant);
          return grantRecord(grant);
        },
      };
    case "vendo_approvals":
      return {
        table: collection,
        select: "SELECT * FROM vendo_approvals",
        cursorColumn: "created_at",
        refs: { subject: "subject", status: "status", call: "call_id" },
        fromDb: (row) => approvalRecord(approvalFromRow(row)),
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
            ...(data.deniedBy === undefined ? {} : { deniedBy: data.deniedBy }),
            ...(data.voidedAt === undefined ? {} : { voidedAt: data.voidedAt }),
            createdAt: data.request.createdAt,
          };
          await putApprovalRow(db, row);
          return approvalRecord(row);
        },
      };
    case "vendo_audit":
      return {
        table: collection,
        select: "SELECT * FROM vendo_audit",
        appendOnly: true,
        cursorColumn: "at",
        refs: { subject: "subject", kind: "kind", app_id: "app_id", tool: "tool" },
        fromDb: (row) => auditRecord(row["event"] as AuditEvent),
        async put(record) {
          const event = parseAuditEvent(record.data);
          requireMatchingId(record.id, event.id, "audit event id");
          // putAuditRow refuses to replace an existing row (append-only, 02 §2).
          await putAuditRow(db, event);
          return auditRecord(event);
        },
      };
    case "vendo_threads":
      return {
        table: collection,
        // v6 (build contract §6): the transcript lives in vendo_thread_messages
        // now, so both reads reassemble it by seq. The door's record shape is
        // unchanged — callers still get `data.messages`.
        select: `SELECT t.*, ${THREAD_MESSAGES_AGGREGATE("t")} AS messages FROM vendo_threads t`,
        // Listing derives only a title + timestamps; skip the (potentially large) transcript
        // once a row carries a stored title. Rows with title still NULL keep returning
        // messages so the title stays derivable.
        listSelect: `SELECT t.id, t.subject, t.title,
           CASE WHEN t.title IS NULL THEN ${THREAD_MESSAGES_AGGREGATE("t")} ELSE '[]'::jsonb END AS messages,
           t.created_at, t.updated_at FROM vendo_threads t`,
        cursorColumn: "created_at",
        refs: { subject: "subject" },
        fromDb: (row) => threadRecord(threadFromRow(row)),
        async put(record) {
          const data = parseThreadData(record.data, record.id);
          // The guarded upsert refuses cross-subject flips (03 §5).
          const row = await putThreadRow(db, { id: record.id, ...data });
          return threadRecord(row);
        },
        // ENG-310: guarded writes (01 §12) backed by the vendo_threads revision
        // counter, so a concurrent-turn persist can read-merge-write without
        // last-write-wins clobbering. Both verbs keep the same cross-subject
        // refusal as put: a foreign-subject write NEVER lands (it just loses —
        // insertIfAbsent finds the id taken, compareAndSwap's guarded WHERE
        // fails — and returns null).
        atomic: {
          async insertIfAbsent(record) {
            requireRecordId(record.id);
            const data = parseThreadData(record.data, record.id);
            // Same door guard as putThreadRow: a transcript that repeats a
            // message id cannot be expressed by one ON CONFLICT statement, so
            // refuse it with a typed error instead of a raw driver 21000.
            const duplicate = duplicateThreadMessageId(data.messages);
            if (duplicate !== undefined) {
              invalid(`thread ${record.id} carries two messages with the id ${JSON.stringify(duplicate)}; message ids must be unique within a thread`);
            }
            const now = new Date().toISOString();
            const result = await db.query(
              `INSERT INTO vendo_threads (id, subject, title, created_at, updated_at, revision)
               VALUES ($1, $2, $3, $4, $4, 1)
               ON CONFLICT (id) DO NOTHING
               RETURNING id, subject, title, created_at, updated_at, revision`,
              [record.id, data.subject, data.title ?? null, now],
            );
            const row = result.rows[0];
            if (row === undefined) return null;
            await replaceThreadMessages(db, record.id, data.messages, now);
            return threadRecord(threadFromRow({ ...row, messages: data.messages }));
          },
          async compareAndSwap(record, expectedRevision) {
            requireRecordId(record.id);
            requireRevision(expectedRevision);
            const data = parseThreadData(record.data, record.id);
            // Same door guard as putThreadRow: a transcript that repeats a
            // message id cannot be expressed by one ON CONFLICT statement, so
            // refuse it with a typed error instead of a raw driver 21000.
            const duplicate = duplicateThreadMessageId(data.messages);
            if (duplicate !== undefined) {
              invalid(`thread ${record.id} carries two messages with the id ${JSON.stringify(duplicate)}; message ids must be unique within a thread`);
            }
            const now = new Date().toISOString();
            const result = await db.query(
              `UPDATE vendo_threads
               SET title = $3, updated_at = $4, revision = revision + 1
               WHERE id = $1 AND subject = $2 AND revision = $5::bigint
               RETURNING id, subject, title, created_at, updated_at, revision`,
              [record.id, data.subject, data.title ?? null, now, expectedRevision],
            );
            const row = result.rows[0];
            if (row === undefined) return null;
            // Only after the CAS won — a loser must not touch the transcript.
            await replaceThreadMessages(db, record.id, data.messages, now);
            return threadRecord(threadFromRow({ ...row, messages: data.messages }));
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
        async put(record) {
          const data = parseRunData(record.data, record.id);
          const row: RunRow = { id: record.id, ...data };
          await putRunRow(db, row);
          return runRecord(row);
        },
      };
    case "vendo_apps":
      return {
        table: collection,
        select: "SELECT * FROM vendo_apps",
        cursorColumn: "created_at",
        refs: {
          subject: "subject",
          ...Object.fromEntries(TRIGGER_KIND_REF_KEYS.map((key) => [key, key])),
        },
        fromDb: (row) => appRecord(appFromRow(row)),
        async put(record) {
          const data = parseAppData(record.data, record.id);
          // The guarded upsert refuses cross-subject flips (02 §2).
          const row = await putAppRow(db, { id: record.id, ...data });
          return appRecord(row);
        },
        // Wave 7: guarded writes (01 §12) backed by the vendo_apps revision
        // counter, so the machine lifecycle and the schedule engine's fire
        // claims (updateAppRow's read-mutate-CAS) arbitrate racers on the dev
        // store instead of degrading to read-then-put. Both verbs keep the
        // same cross-subject refusal as put: a foreign-subject write NEVER
        // lands (insertIfAbsent finds the id taken, compareAndSwap's guarded
        // WHERE fails — and returns null). The doc's trigger_kind projection
        // is a generated column, so guarded writes keep it for free.
        atomic: {
          async insertIfAbsent(record) {
            requireRecordId(record.id);
            const data = parseAppData(record.data, record.id);
            const now = new Date().toISOString();
            const result = await db.query(
              `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at, revision)
               VALUES ($1, $2, $3, $4::jsonb, $5, $5, 1)
               ON CONFLICT (id) DO NOTHING
               RETURNING id, subject, enabled, doc, created_at, updated_at, revision`,
              [record.id, data.subject, data.enabled, JSON.stringify(data.doc), now],
            );
            return result.rows[0]
              ? appRecord(appFromRow(result.rows[0] as Record<string, unknown>))
              : null;
          },
          async compareAndSwap(record, expectedRevision) {
            requireRecordId(record.id);
            requireRevision(expectedRevision);
            const data = parseAppData(record.data, record.id);
            const now = new Date().toISOString();
            const result = await db.query(
              `UPDATE vendo_apps
               SET enabled = $3, doc = $4::jsonb, updated_at = $5, revision = revision + 1
               WHERE id = $1 AND subject = $2 AND revision = $6::bigint
               RETURNING id, subject, enabled, doc, created_at, updated_at, revision`,
              [record.id, data.subject, data.enabled, JSON.stringify(data.doc), now, expectedRevision],
            );
            return result.rows[0]
              ? appRecord(appFromRow(result.rows[0] as Record<string, unknown>))
              : null;
          },
        },
      };
    case "vendo_effects":
      return {
        table: collection,
        // Contract §7: the effect ledger, in ITS OWN table — subject-adoption
        // (helpers/subjects.ts) and the erase cascade both address
        // `vendo_effects` directly, so receipts routed to the generic table
        // would be invisible to both (found by the wave-1 independent check).
        // The PK is `key`, aliased so the door's generic id machinery works.
        select: "SELECT * FROM (SELECT key AS id, subject, outcome, at FROM vendo_effects) e",
        // Receipts are a ledger: never deleted through the door, erased only
        // via the store erase API — same law as vendo_audit.
        appendOnly: true,
        cursorColumn: "at",
        refs: { subject: "subject" },
        fromDb: effectRecord,
        async put(record) {
          // Insert-once even on the plain door: a receipt that exists is the
          // truth about what already executed; overwriting it is how a re-run
          // double-sends. Losing the race returns the recorded row.
          const inserted = await insertEffect(db, record);
          if (inserted) return inserted;
          const existing = await db.query(
            "SELECT key AS id, subject, outcome, at FROM vendo_effects WHERE key = $1",
            [record.id],
          );
          return effectRecord(existing.rows[0] as Record<string, unknown>);
        },
        atomic: {
          async insertIfAbsent(record) {
            requireRecordId(record.id);
            return insertEffect(db, record);
          },
          async compareAndSwap() {
            throw new VendoError(
              "blocked",
              "vendo_effects receipts are immutable once written; only insertIfAbsent is supported",
            );
          },
        },
      };
    case "vendo_app_grants":
      return {
        table: collection,
        // Contract §9.2: app → principal → level, in ITS OWN table — the erase
        // cascade and the by-app cascade both address `vendo_app_grants`
        // directly, so grants routed to the generic table would be invisible
        // to both (the vendo_effects lesson).
        select: "SELECT * FROM vendo_app_grants",
        cursorColumn: "created_at",
        refs: { app_id: "app_id", org_id: "org_id", principal: "principal", level: "level" },
        fromDb: appGrantRecord,
        async put(record) {
          const data = parseAppGrantData(record.data, record.id);
          // One row per (app, principal): re-granting UPDATES the level in
          // place rather than accreting rows a max() would have to reconcile.
          // The original id survives, so a revoke by id stays stable.
          const result = await db.query(
            `INSERT INTO vendo_app_grants (id, app_id, org_id, principal, level, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (app_id, principal)
               DO UPDATE SET level = EXCLUDED.level, created_by = EXCLUDED.created_by,
                             org_id = EXCLUDED.org_id
             RETURNING *`,
            [record.id, data.appId, data.orgId, data.principal, data.level, data.createdBy],
          );
          return appGrantRecord(result.rows[0] as Record<string, unknown>);
        },
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
        validateId: (id) => void splitStateId(id),
        async put(record) {
          const { appId, subject } = splitStateId(record.id);
          const data = requireJson(record.data, "state data");
          // Shared persistent write path with the harness slot (helpers/rows).
          return stateRecord(await putStateRow(db, { appId, subject, data }));
        },
      };
  }
}

export function createReservedRecordStore(
  db: Db,
  collection: string,
): RecordStore | undefined {
  if ((DEDICATED_RECORD_COLLECTIONS as readonly string[]).includes(collection)) {
    return createRecordStore(db, collection, collection as DedicatedRecordTable);
  }
  if (!(RESERVED_COLLECTIONS as readonly string[]).includes(collection)) return undefined;
  return createTableRecordStore(db, configFor(db, collection as ReservedCollection));
}
