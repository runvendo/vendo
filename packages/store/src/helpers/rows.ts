import {
  VendoError,
  type AppDocument,
  type AuditEvent,
  type Json,
  type PermissionGrant,
} from "@vendoai/core";
import type { Db } from "../db.js";
import type { AppRow, ApprovalRow, RunRow, StateRow, ThreadRow } from "./types.js";
import { iso, optionalIso, text } from "./utils.js";

export function appFromRow(row: Record<string, unknown>): AppRow {
  const revision = row["revision"];
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    enabled: row["enabled"] === true,
    doc: row["doc"] as AppDocument,
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
    ...(typeof revision === "string" || typeof revision === "number" || typeof revision === "bigint"
      ? { revision: String(revision) }
      : {}),
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
  // Every write bumps the revision counter (Wave 7), so a token read before a
  // plain put can no longer compareAndSwap — same discipline as putThreadRow.
  const result = await db.query(
    `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at, revision)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 1)
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled,
       doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at,
       revision = vendo_apps.revision + 1
       WHERE vendo_apps.subject = EXCLUDED.subject
     RETURNING id, subject, enabled, doc, created_at, updated_at, revision`,
    [input.id, input.subject, input.enabled, JSON.stringify(input.doc), now],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new VendoError("conflict", `app ${input.id} belongs to another subject`);
  }
  return appFromRow(row as Record<string, unknown>);
}

/** Build contract §6 — `vendo_threads` no longer stores `messages`, but the
 *  reserved-collection door and `threadStore` still hand callers a whole
 *  thread. This aggregate reassembles the transcript **by seq** (never by
 *  timestamp: approval flips rewrite older messages) so those read paths keep
 *  their shape while storage is one row per message.
 *
 *  Interpolated, not parameterized, because it names a correlated alias rather
 *  than carrying a value — there is no user input anywhere in it. */
export const THREAD_MESSAGES_AGGREGATE = (alias: string): string =>
  // `m.id` is the tie-break, and it is load-bearing rather than tidy: `seq` is
  // assigned as max(seq)+1 with no unique constraint, so two concurrent writers
  // to one thread can land on the same seq. Ordering by seq ALONE would then
  // leave the reassembled transcript in an undefined order — and the transcript
  // is what the next turn reads, so "undefined" means a conversation that reads
  // differently on each load. (A UNIQUE (thread_id, seq) constraint would be the
  // stronger fix, but it would make `replaceThreadMessages` fail mid-statement
  // whenever an edit reorders two messages; noted in the lane report.)
  `COALESCE((SELECT jsonb_agg(m.message ORDER BY m.seq, m.id)
             FROM vendo_thread_messages m WHERE m.thread_id = ${alias}.id), '[]'::jsonb)`;

/** Every row id this transcript will occupy, in array order.
 *
 *  Split out because it is also the DOOR's validation: `ON CONFLICT` cannot be
 *  given the same key twice in one statement (Postgres raises a bare 21000
 *  cardinality violation), so a transcript carrying two messages with one id used
 *  to fail with a raw driver error and lose the whole write. Callers check here
 *  first and refuse with a typed error that names the offender. */
export function threadMessageRowIds(messages: Json[]): string[] {
  return messages.map((message, index) => {
    const id = (message as { id?: unknown } | null)?.id;
    return typeof id === "string" && id !== "" ? id : `msg_${index}`;
  });
}

/** The first row id that appears more than once, or undefined if all are unique. */
export function duplicateThreadMessageId(messages: Json[]): string | undefined {
  const seen = new Set<string>();
  for (const id of threadMessageRowIds(messages)) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

/** Land this thread's transcript as rows: array index becomes `seq`, an unchanged
 *  message keeps its revision, and a message that left the array loses its row.
 *  Two statements, each set-based — never one round trip per message.
 *
 *  Requires ids to be unique already (`duplicateThreadMessageId`); the door
 *  enforces that, because this statement cannot express a collision without
 *  dropping one side. */
export async function replaceThreadMessages(
  db: Db,
  threadId: string,
  messages: Json[],
  now = new Date().toISOString(),
): Promise<void> {
  // A legacy/hand-written row may hold messages with no `id` (the door accepts
  // any Json). Derive a positional id for those rather than dropping them.
  //
  // The ids are derived ONCE, in TypeScript, and passed in beside the messages.
  // SQL used to re-derive them with `COALESCE(elem->>'id', …)`, which disagreed
  // with the TypeScript rule on an empty-string id ('' is not NULL, so COALESCE
  // kept it) and on a non-string id (`elem->>'id'` renders 5 as '5'). The
  // duplicate guard runs on the TypeScript rule, so those inputs cleared it and
  // then collided inside this statement — the bare 21000 the guard exists to
  // prevent. One derivation means the guard and the statement cannot disagree.
  const ids = threadMessageRowIds(messages);
  await db.query(
    `INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
     SELECT $1, ids.id, (a.ordinality - 1)::integer, a.elem, $4, $4
     FROM unnest($3::text[]) WITH ORDINALITY AS ids(id, n)
     JOIN jsonb_array_elements($2::jsonb) WITH ORDINALITY AS a(elem, ordinality)
       ON a.ordinality = ids.n
     ON CONFLICT (thread_id, id) DO UPDATE
       SET seq = EXCLUDED.seq, message = EXCLUDED.message, updated_at = EXCLUDED.updated_at,
           revision = vendo_thread_messages.revision + 1
       WHERE vendo_thread_messages.message IS DISTINCT FROM EXCLUDED.message
          OR vendo_thread_messages.seq IS DISTINCT FROM EXCLUDED.seq`,
    [threadId, JSON.stringify(messages), ids, now],
  );
  await db.query(
    "DELETE FROM vendo_thread_messages WHERE thread_id = $1 AND id <> ALL ($2::text[])",
    [threadId, ids],
  );
}

/** Append (or edit) a batch of messages on a thread this subject owns, without
 *  reading the transcript first — the one-statement ownership the hosted path
 *  never had (the read-then-write TOCTOU named at helpers/thread-messages.ts).
 *
 *  Two statements, both set-based, and the CALLER runs them in one transaction:
 *  1. create-or-touch the thread row, guarded on the subject exactly as
 *     putThreadRow's upsert is — an empty RETURNING means a foreign row holds
 *     the id, and the whole append is refused before a message row exists;
 *  2. one multi-row insert for the messages.
 *  Statement 1 leaves the thread row write-locked for the rest of the
 *  transaction, so statement 2 needs neither the ownership join nor the
 *  `FOR KEY SHARE OF t` its single-row sibling carries: a concurrent
 *  `deleteThread` cascade cannot slip between them and leave orphan rows.
 *
 *  `seq` is assigned HERE, by statement 2, and never by the caller — the fix
 *  for a real race (proven on PostgreSQL 17: 40 concurrent appends, 21 distinct
 *  seqs). `seq` carries conversation order and has no unique constraint, so two
 *  turns landing on the same number make the transcript fall back to ordering
 *  by message id, which is not turn order. Any `max(seq) + 1` read taken BEFORE
 *  the thread row is held is read by both racers under READ COMMITTED and hands
 *  them the same answer. Statement 1 above is what serialises them: the loser
 *  blocks there (on the row lock, or on the primary key when both are creating
 *  the thread) until the winner COMMITs, so statement 2's subquery — a new
 *  snapshot in READ COMMITTED — already sees the winner's rows.
 *
 *  `seq` is NOT updated on conflict. An append names where NEW messages go; a
 *  message the thread already holds has a decided position, and moving it would
 *  reorder the conversation the next turn reads. New rows land after the tail in
 *  batch order, which is the only rule the wire half can honor anyway — a wire
 *  body carries no seq — so both halves of `upsertMany` share this exactly. */
export async function appendThreadMessages(
  db: Db,
  input: {
    threadId: string;
    subject: string;
    messages: ReadonlyArray<{ id: string; message: unknown }>;
    title?: string;
  },
  now = new Date().toISOString(),
): Promise<{ revision: string; count: number }> {
  // An empty batch has nothing to land, and it must not touch the thread on its
  // way to doing nothing: statement 1 below is an UPSERT, so an empty append
  // would bump the revision of a thread it changed nothing in — and CREATE one
  // that did not exist. The wire has always refused it
  // (`storeWireTranscriptsAppendMessagesRequestSchema`, `messages.min(1)`), so
  // this is the SQL half catching up rather than a new rule; the one caller,
  // `upsertMany`, already returns early on an empty list.
  if (input.messages.length === 0) {
    throw new VendoError(
      "validation",
      `transcripts.appendMessages needs at least one message; the batch for thread ${input.threadId} was empty`,
    );
  }
  // ON CONFLICT cannot be given the same key twice in one statement (a bare
  // 21000 that loses the whole write), so the same guard putThreadRow applies
  // to a transcript applies to a batch — with the offender named.
  const seen = new Set<string>();
  for (const { id } of input.messages) {
    if (seen.has(id)) {
      throw new VendoError(
        "validation",
        `thread ${input.threadId} carries two messages with the id ${JSON.stringify(id)}; message ids must be unique within a thread`,
      );
    }
    seen.add(id);
  }
  // A title rides along when the caller derived one; it must never CLEAR the
  // stored title, which is why this is a COALESCE and putThreadRow's is not
  // (that call owns the whole row and always carries the title it wants).
  const touched = await db.query(
    `INSERT INTO vendo_threads (id, subject, title, created_at, updated_at, revision)
     VALUES ($1, $2, $3, $4, $4, 1)
     ON CONFLICT (id) DO UPDATE
       SET title = COALESCE(EXCLUDED.title, vendo_threads.title),
           updated_at = EXCLUDED.updated_at,
           revision = vendo_threads.revision + 1
       WHERE vendo_threads.subject = EXCLUDED.subject
     RETURNING revision`,
    [input.threadId, input.subject, input.title ?? null, now],
  );
  const row = touched.rows[0];
  if (row === undefined) {
    throw new VendoError("conflict", `thread ${input.threadId} belongs to another subject`);
  }
  const landed = await db.query(
    `INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
     SELECT $1, m.id, tail.next + m.n - 1, a.elem, $4, $4
     FROM unnest($2::text[]) WITH ORDINALITY AS m(id, n)
     JOIN jsonb_array_elements($3::jsonb) WITH ORDINALITY AS a(elem, ordinality)
       ON a.ordinality = m.n
     CROSS JOIN (SELECT COALESCE(max(seq) + 1, 0) AS next
                 FROM vendo_thread_messages WHERE thread_id = $1) tail
     ON CONFLICT (thread_id, id) DO UPDATE
       SET message = EXCLUDED.message, updated_at = EXCLUDED.updated_at,
           revision = vendo_thread_messages.revision + 1
     RETURNING id`,
    [
      input.threadId,
      input.messages.map((entry) => entry.id),
      JSON.stringify(input.messages.map((entry) => entry.message)),
      now,
    ],
  );
  return { revision: String(row["revision"]), count: landed.rows.length };
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
  // Refuse a colliding transcript BEFORE writing the thread row, so a rejected
  // write leaves nothing behind. Client-minted ids are not unique by
  // construction, so this is a real input, not a defensive check.
  const duplicate = duplicateThreadMessageId(input.messages);
  if (duplicate !== undefined) {
    throw new VendoError(
      "validation",
      `thread ${input.id} carries two messages with the id ${JSON.stringify(duplicate)}; message ids must be unique within a thread`,
    );
  }
  const result = await db.query(
    `INSERT INTO vendo_threads (id, subject, title, created_at, updated_at, revision)
     VALUES ($1, $2, $3, $4, $4, 1)
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title, updated_at = EXCLUDED.updated_at,
           revision = vendo_threads.revision + 1
       WHERE vendo_threads.subject = EXCLUDED.subject
     RETURNING id, subject, title, created_at, updated_at, revision`,
    [input.id, input.subject, input.title ?? null, now],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new VendoError("conflict", `thread ${input.id} belongs to another subject`);
  }
  // Only after the guard above admitted the write — so a refused cross-subject
  // flip never leaves messages behind.
  await replaceThreadMessages(db, input.id, input.messages, now);
  return threadFromRow({ ...row, messages: input.messages });
}

export function stateRowFromRow(row: Record<string, unknown>): StateRow {
  return {
    appId: text(row["app_id"]),
    subject: text(row["subject"]),
    data: row["data"] as Json,
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

/** The single persistent write path for vendo_state, shared by the routed
 *  records("vendo_state").put and the harness slot so the doors never drift. Writes
 *  created_at once on insert and PRESERVES it on conflict (only data + updated_at
 *  change), so the seam's createdAt is stable across puts. Never writes the
 *  generated `id` column. */
export async function putStateRow(
  db: Db,
  input: { appId: string; subject: string; data: Json },
  now = new Date().toISOString(),
): Promise<StateRow> {
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
    // WHICH automation the grant was minted for. Load-bearing, not metadata: the
    // guard refuses an away call whose grant names a different record, so
    // dropping it here would let one automation's consent authorize another's.
    ...(row["automation_id"] == null ? {} : { automationId: text(row["automation_id"]) }),
    source: text(row["source"]) as PermissionGrant["source"],
    grantedAt: iso(row["granted_at"]),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

export async function putGrantRow(db: Db, grant: PermissionGrant): Promise<void> {
  // Grants never cross subjects either (02 §2). The upsert carries the same
  // atomic guard as putThreadRow/putAppRow: on conflict it updates ONLY when
  // the existing row already belongs to EXCLUDED.subject; an empty RETURNING
  // means a foreign row holds the id — refuse the flip.
  const result = await db.query(
    `INSERT INTO vendo_grants
     (id, subject, tool, descriptor_hash, scope, duration, context_key, app_id, automation_id, source, granted_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET tool = EXCLUDED.tool,
       descriptor_hash = EXCLUDED.descriptor_hash, scope = EXCLUDED.scope,
       duration = EXCLUDED.duration, context_key = EXCLUDED.context_key,
       app_id = EXCLUDED.app_id, automation_id = EXCLUDED.automation_id,
       source = EXCLUDED.source, granted_at = EXCLUDED.granted_at,
       expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at
       WHERE vendo_grants.subject = EXCLUDED.subject
     RETURNING id`,
    [grant.id, grant.subject, grant.tool, grant.descriptorHash, JSON.stringify(grant.scope), grant.duration,
      grant.contextKey ?? null, grant.appId ?? null, grant.automationId ?? null, grant.source, grant.grantedAt,
      grant.expiresAt ?? null, grant.revokedAt ?? null],
  );
  if (result.rows[0] === undefined) {
    throw new VendoError("conflict", `grant ${grant.id} belongs to another subject`);
  }
}

export function approvalFromRow(row: Record<string, unknown>): ApprovalRow {
  const decidedAt = optionalIso(row["decided_at"]);
  const consumedAt = optionalIso(row["consumed_at"]);
  const voidedAt = optionalIso(row["voided_at"]);
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    request: row["request"] as ApprovalRow["request"],
    status: text(row["status"]) as ApprovalRow["status"],
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(row["session_id"] == null ? {} : { sessionId: text(row["session_id"]) }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(row["denied_by"] == null ? {} : { deniedBy: text(row["denied_by"]) as ApprovalRow["deniedBy"] }),
    ...(voidedAt === undefined ? {} : { voidedAt }),
    createdAt: iso(row["created_at"]),
  };
}

export async function putApprovalRow(db: Db, row: ApprovalRow, upsert = true): Promise<void> {
  await db.query(
    `INSERT INTO vendo_approvals
     (id, subject, request, status, decided_at, session_id, consumed_at, denied_by, voided_at, call_id, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
     ${upsert ? `ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, request = EXCLUDED.request,
       status = EXCLUDED.status, decided_at = EXCLUDED.decided_at,
       session_id = EXCLUDED.session_id, consumed_at = EXCLUDED.consumed_at,
       denied_by = EXCLUDED.denied_by, voided_at = EXCLUDED.voided_at, call_id = EXCLUDED.call_id,
       created_at = EXCLUDED.created_at` : ""}`,
    [row.id, row.subject, JSON.stringify(row.request), row.status, row.decidedAt ?? null,
      row.sessionId ?? null, row.consumedAt ?? null, row.deniedBy ?? null, row.voidedAt ?? null,
      // `call_id` is a denormalized index column, always the request's own call
      // id — the guard looks a decision up by the call it answers.
      row.request.call.id, row.createdAt],
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
    automationId: text(row["automation_id"]),
    trigger: row["trigger"] as RunRow["trigger"],
    status: text(row["status"]) as RunRow["status"],
    record: row["record"],
    startedAt: iso(row["started_at"]),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

export async function putRunRow(db: Db, run: RunRow): Promise<void> {
  await db.query(
    `INSERT INTO vendo_runs (id, automation_id, trigger, status, record, started_at, finished_at)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET automation_id = EXCLUDED.automation_id, trigger = EXCLUDED.trigger,
       status = EXCLUDED.status, record = EXCLUDED.record, started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at`,
    [run.id, run.automationId, JSON.stringify(run.trigger), run.status, JSON.stringify(run.record),
      run.startedAt, run.finishedAt ?? null],
  );
}
