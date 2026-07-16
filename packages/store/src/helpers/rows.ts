import {
  VendoError,
  type AppDocument,
  type AuditEvent,
  type Json,
  type PermissionGrant,
} from "@vendoai/core";
import type { Db } from "../db.js";
import type { AppRow, ApprovalRow, EphemeralStateRow, RunRow, ThreadRow } from "./types.js";
import { iso, optionalIso, text } from "./utils.js";

export function appFromRow(row: Record<string, unknown>): AppRow {
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    enabled: row["enabled"] === true,
    doc: row["doc"] as AppDocument,
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

export async function putAppRow(
  db: Db,
  input: Pick<AppRow, "id" | "subject" | "enabled" | "doc">,
  now = new Date().toISOString(),
): Promise<AppRow> {
  // Apps never cross subjects (02 §2: the app row IS the user's copy). Same
  // atomic guard as putThreadRow: on conflict the update applies ONLY when the
  // existing row already belongs to EXCLUDED.subject — otherwise the WHERE
  // fails, RETURNING is empty, and the cross-subject flip is refused without a
  // TOCTOU window.
  const result = await db.query(
    `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5)
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled,
       doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at
       WHERE vendo_apps.subject = EXCLUDED.subject
     RETURNING id, subject, enabled, doc, created_at, updated_at`,
    [input.id, input.subject, input.enabled, JSON.stringify(input.doc), now],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new VendoError("conflict", `app ${input.id} belongs to another subject`);
  }
  return appFromRow(row as Record<string, unknown>);
}

export function threadFromRow(row: Record<string, unknown>): ThreadRow {
  const title = row["title"];
  const revision = row["revision"];
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    messages: row["messages"] as ThreadRow["messages"],
    ...(typeof title === "string" ? { title } : {}),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
    ...(typeof revision === "string" || typeof revision === "number" || typeof revision === "bigint"
      ? { revision: String(revision) }
      : {}),
  };
}

export async function putThreadRow(
  db: Db,
  input: Pick<ThreadRow, "id" | "subject" | "messages" | "title">,
  now = new Date().toISOString(),
): Promise<ThreadRow> {
  // Threads never cross subjects (03 §5). vendo_threads is keyed by the bare id,
  // so the upsert is guarded ATOMICALLY: on conflict it updates ONLY when the
  // existing row already belongs to EXCLUDED.subject — otherwise the WHERE fails,
  // no row is written, RETURNING is empty, and we refuse the cross-subject flip.
  // This closes the TOCTOU window that a resolve()-time pre-check alone cannot
  // (a foreign row can appear during a long streaming turn, before persist runs).
  const result = await db.query(
    `INSERT INTO vendo_threads (id, subject, messages, title, created_at, updated_at, revision)
     VALUES ($1, $2, $3::jsonb, $4, $5, $5, 1)
     ON CONFLICT (id) DO UPDATE
       SET messages = EXCLUDED.messages, title = EXCLUDED.title, updated_at = EXCLUDED.updated_at,
           revision = vendo_threads.revision + 1
       WHERE vendo_threads.subject = EXCLUDED.subject
     RETURNING id, subject, messages, title, created_at, updated_at, revision`,
    [input.id, input.subject, JSON.stringify(input.messages), input.title ?? null, now],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new VendoError("conflict", `thread ${input.id} belongs to another subject`);
  }
  return threadFromRow(row as Record<string, unknown>);
}

export function stateRowFromRow(row: Record<string, unknown>): EphemeralStateRow {
  return {
    appId: text(row["app_id"]),
    subject: text(row["subject"]),
    data: row["data"] as Json,
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

/** The single persistent write path for vendo_state, shared by stateStore.put and
 *  the routed records("vendo_state").put so the two doors never drift. Writes
 *  created_at once on insert and PRESERVES it on conflict (only data + updated_at
 *  change), so the seam's createdAt is stable across puts. Never writes the
 *  generated `id` column. */
export async function putStateRow(
  db: Db,
  input: { appId: string; subject: string; data: Json },
  now = new Date().toISOString(),
): Promise<EphemeralStateRow> {
  const result = await db.query(
    `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $4)
     ON CONFLICT (app_id, subject) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
     RETURNING app_id, subject, data, created_at, updated_at`,
    [input.appId, input.subject, JSON.stringify(input.data), now],
  );
  return stateRowFromRow(result.rows[0] as Record<string, unknown>);
}

export function grantFromRow(row: Record<string, unknown>): PermissionGrant {
  const expiresAt = optionalIso(row["expires_at"]);
  const revokedAt = optionalIso(row["revoked_at"]);
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    tool: text(row["tool"]),
    descriptorHash: text(row["descriptor_hash"]),
    scope: row["scope"] as PermissionGrant["scope"],
    duration: text(row["duration"]) as PermissionGrant["duration"],
    ...(row["context_key"] == null ? {} : { contextKey: text(row["context_key"]) }),
    ...(row["app_id"] == null ? {} : { appId: text(row["app_id"]) }),
    source: text(row["source"]) as PermissionGrant["source"],
    grantedAt: iso(row["granted_at"]),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

export async function putGrantRow(db: Db, grant: PermissionGrant, upsert = true): Promise<void> {
  // Grants never cross subjects either (02 §2). The upsert carries the same
  // atomic guard as putThreadRow/putAppRow: on conflict it updates ONLY when
  // the existing row already belongs to EXCLUDED.subject; an empty RETURNING
  // on the upsert path means a foreign row holds the id — refuse the flip.
  const result = await db.query(
    `INSERT INTO vendo_grants
     (id, subject, tool, descriptor_hash, scope, duration, context_key, app_id, source, granted_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
     ${upsert ? `ON CONFLICT (id) DO UPDATE SET tool = EXCLUDED.tool,
       descriptor_hash = EXCLUDED.descriptor_hash, scope = EXCLUDED.scope,
       duration = EXCLUDED.duration, context_key = EXCLUDED.context_key,
       app_id = EXCLUDED.app_id, source = EXCLUDED.source, granted_at = EXCLUDED.granted_at,
       expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at
       WHERE vendo_grants.subject = EXCLUDED.subject` : ""}
     RETURNING id`,
    [grant.id, grant.subject, grant.tool, grant.descriptorHash, JSON.stringify(grant.scope), grant.duration,
      grant.contextKey ?? null, grant.appId ?? null, grant.source, grant.grantedAt,
      grant.expiresAt ?? null, grant.revokedAt ?? null],
  );
  if (upsert && result.rows[0] === undefined) {
    throw new VendoError("conflict", `grant ${grant.id} belongs to another subject`);
  }
}

export function approvalFromRow(row: Record<string, unknown>): ApprovalRow {
  const decidedAt = optionalIso(row["decided_at"]);
  const consumedAt = optionalIso(row["consumed_at"]);
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    request: row["request"] as ApprovalRow["request"],
    status: text(row["status"]) as ApprovalRow["status"],
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(row["session_id"] == null ? {} : { sessionId: text(row["session_id"]) }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    createdAt: iso(row["created_at"]),
  };
}

export async function putApprovalRow(db: Db, row: ApprovalRow, upsert = true): Promise<void> {
  await db.query(
    `INSERT INTO vendo_approvals
     (id, subject, request, status, decided_at, session_id, consumed_at, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
     ${upsert ? `ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, request = EXCLUDED.request,
       status = EXCLUDED.status, decided_at = EXCLUDED.decided_at,
       session_id = EXCLUDED.session_id, consumed_at = EXCLUDED.consumed_at,
       created_at = EXCLUDED.created_at` : ""}`,
    [row.id, row.subject, JSON.stringify(row.request), row.status, row.decidedAt ?? null,
      row.sessionId ?? null, row.consumedAt ?? null, row.createdAt],
  );
}

/** 02-store §2: vendo_audit is append-only. The insert refuses to touch an
 *  existing row ATOMICALLY — ON CONFLICT DO NOTHING plus an empty RETURNING
 *  means the id already exists, and the write is rejected instead of replacing
 *  history. Deletion happens only through the store erase API (02 §5). */
export async function putAuditRow(db: Db, event: AuditEvent): Promise<void> {
  const result = await db.query(
    `INSERT INTO vendo_audit (id, at, kind, subject, venue, presence, app_id, tool, event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [event.id, event.at, event.kind, event.principal.subject, event.venue, event.presence,
      event.appId ?? null, event.tool ?? null, JSON.stringify(event)],
  );
  if (result.rows[0] === undefined) {
    throw new VendoError("conflict", `audit event ${event.id} already exists (vendo_audit is append-only)`);
  }
}

export function runFromRow(row: Record<string, unknown>): RunRow {
  const finishedAt = optionalIso(row["finished_at"]);
  return {
    id: text(row["id"]),
    appId: text(row["app_id"]),
    trigger: row["trigger"] as RunRow["trigger"],
    status: text(row["status"]) as RunRow["status"],
    record: row["record"],
    startedAt: iso(row["started_at"]),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

export async function putRunRow(db: Db, run: RunRow): Promise<void> {
  await db.query(
    `INSERT INTO vendo_runs (id, app_id, trigger, status, record, started_at, finished_at)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id, trigger = EXCLUDED.trigger,
       status = EXCLUDED.status, record = EXCLUDED.record, started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at`,
    [run.id, run.appId, JSON.stringify(run.trigger), run.status, JSON.stringify(run.record),
      run.startedAt, run.finishedAt ?? null],
  );
}
