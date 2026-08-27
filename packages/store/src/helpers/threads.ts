import { VendoError, type Json, type Principal, type StoreOps, type ThreadId, type VendoRecord } from "@vendoai/core";
import type { Db } from "../db-postgres.js";
import type { VendoStore } from "../store.js";
import { backendOf } from "./backend.js";
import type { ThreadRow } from "./types.js";
import { putThreadRow, THREAD_MESSAGES_AGGREGATE, threadFromRow } from "./rows.js";
import { iso, text } from "./utils.js";
import { parseThreadData } from "../validate.js";

/** One answer to one `ask_user` question (design §4). `answer` is opaque to the
 *  store — whatever the card collected. Any `subject` inside it is IGNORED:
 *  ownership comes from the authenticated principal, never from the payload. */
export interface AskUserAnswer {
  threadId: ThreadId;
  /** The question this answers. Also the message id, which is what makes
   *  recording idempotent — a double-submitted card cannot double-answer. */
  questionId: string;
  answer: Json;
}

/** 02-store §3 — the surface, whichever backend serves it. */
export interface ThreadStore {
  put(principal: Principal, thread: { id: ThreadId; messages: Json[] }): Promise<ThreadRow>;
  get(principal: Principal, id: ThreadId): Promise<ThreadRow | null>;
  list(principal: Principal): Promise<Array<{ id: ThreadId; createdAt: string; updatedAt: string }>>;
  delete(principal: Principal, id: ThreadId): Promise<void>;
  /** Record an `ask_user` answer into the answerer's OWN thread. */
  recordAnswer(principal: Principal, answer: AskUserAnswer): Promise<void>;
}

/** 02-store §3 */
export function threadStore(store: VendoStore): ThreadStore {
  const backend = backendOf(store, "conversations (02-store §3)");
  return backend.kind === "ops" ? overOps(backend.ops) : overSql(backend.db);
}

/** The inverse of `threadRecord` (routing.ts): the wire's transcript record,
 *  read back as the row every caller of this helper already speaks. */
function threadFromRecord(record: VendoRecord): ThreadRow {
  const data = record.data as { subject?: unknown; messages?: unknown; title?: unknown };
  return {
    id: record.id,
    subject: text(data.subject),
    messages: Array.isArray(data.messages) ? data.messages as Json[] : [],
    ...(typeof data.title === "string" ? { title: data.title } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.revision === undefined ? {} : { revision: record.revision }),
  };
}

/**
 * The hosted half: conversations ride `vendo/store-wire@1`'s transcripts
 * family, verb for verb — which is what lets a key-only deployment hold one.
 *
 * Three honest differences from the SQL half:
 * - **Ownership is read-then-write**, not one statement. The TOCTOU window that
 *   opens is between two writes by the same subject to a thread whose owner
 *   would have to change mid-call, which the store has no verb for. (`put` is
 *   the exception: it sends the subject, and the service's own guarded upsert
 *   refuses a cross-subject flip atomically, exactly as SQL does.)
 * - **`list` is ordered by the wire's cursor column** rather than by
 *   `updated_at DESC`. It is still every thread: the pages are walked to
 *   exhaustion, because the returned array is the caller's only handle.
 * - **An answer carries its question id in its payload.** The wire derives the
 *   answer's row id from the answer itself, so `questionId` rides along as
 *   `id` — which is what keeps `ans_<questionId>` the row id here too, and with
 *   it the loud refusal of a reused question id.
 */
function overOps(ops: StoreOps): ThreadStore {
  /** The thread record is the ownership record on the wire exactly as the
   *  `vendo_threads` row is in SQL: `data.subject` is the same field the join
   *  reads. A foreign or absent thread yields nothing, so reads answer empty
   *  and writes refuse — mirroring the local empty-read. */
  const owned = async (principal: Principal, id: ThreadId): Promise<VendoRecord | undefined> => {
    const record = await ops.transcripts.getThread(id);
    if (record === null) return undefined;
    return (record.data as { subject?: unknown }).subject === principal.subject ? record : undefined;
  };

  return {
    async put(principal, thread) {
      const parsed = parseThreadData({ subject: principal.subject, messages: thread.messages }, thread.id);
      return threadFromRecord(await ops.transcripts.putThread({ id: thread.id, ...parsed }));
    },
    async get(principal, id) {
      const record = await owned(principal, id);
      return record === undefined ? null : threadFromRecord(record);
    },
    async list(principal) {
      // `ThreadStore.list` hands back a complete array — it has no cursor of its
      // own — so the service's pages are followed here. A service that repeats a
      // cursor ends the walk rather than spinning (byo-approvals' `listAll`).
      const records: VendoRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await ops.transcripts.listThreads({
          subject: principal.subject,
          ...(cursor === undefined ? {} : { cursor }),
        });
        records.push(...page.records);
        if (page.cursor === undefined || page.cursor === cursor) break;
        cursor = page.cursor;
      } while (cursor !== undefined);
      return records.map((record) => ({
        id: record.id,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
    },
    async delete(principal, id) {
      // The service cascades (thread + messages + harness state) exactly as the
      // SQL transaction below does; a foreign principal sweeps nothing.
      if (await owned(principal, id) === undefined) return;
      await ops.transcripts.deleteThread(id);
    },
    async recordAnswer(principal, { threadId, questionId, answer }) {
      if (await owned(principal, threadId) === undefined) {
        throw new VendoError("conflict", `thread ${threadId} does not belong to this subject`);
      }
      await ops.transcripts.recordAnswer(threadId, { id: questionId, answer });
    },
  };
}

/** The SQL half: the statements are the enforcement. */
function overSql(db: Db): ThreadStore {
  return {
    async put(principal, thread) {
      const parsed = parseThreadData({ subject: principal.subject, messages: thread.messages }, thread.id);
      // Threads never cross subjects (03 §5): the guarded upsert refuses a
      // foreign-owned id atomically.
      return putThreadRow(db, {
        id: thread.id,
        subject: parsed.subject,
        messages: parsed.messages,
      });
    },
    async get(principal, id) {
      // v6 (build contract §6): the transcript is reassembled by seq from
      // vendo_thread_messages — the thread row holds metadata only.
      const result = await db.query(
        `SELECT t.id, t.subject, ${THREAD_MESSAGES_AGGREGATE("t")} AS messages,
                t.title, t.created_at, t.updated_at, t.revision FROM vendo_threads t
         WHERE t.id = $1 AND t.subject = $2`,
        [id, principal.subject],
      );
      return result.rows[0] ? threadFromRow(result.rows[0]) : null;
    },
    async list(principal) {
      const result = await db.query(
        `SELECT id, created_at, updated_at FROM vendo_threads WHERE subject = $1
         ORDER BY updated_at DESC, id DESC`,
        [principal.subject],
      );
      return result.rows.map((row) => ({
        id: text(row["id"]),
        createdAt: iso(row["created_at"]),
        updatedAt: iso(row["updated_at"]),
      }));
    },
    async delete(principal, id) {
      // The delete is a CASCADE, in one transaction: the thread row, its v6
      // message rows, and its harness state die together.
      //
      // `vendo_thread_messages` has no foreign key, and a message row carries no
      // subject of its own — the thread row IS the ownership record. So a
      // message left behind here is unreachable forever: `erase.bySubject` finds
      // transcript rows only through `thread_id IN (SELECT id FROM vendo_threads
      // WHERE subject = $1)`, and that subquery is empty once the thread is
      // gone. The harness state needs no statement at all since v12 — it is a
      // COLUMN on the thread row, so the DELETE below is what takes it.
      //
      // Every drop is guarded on the RETURNING row, so a foreign principal's
      // no-op delete sweeps nothing.
      await db.transaction(async (q) => {
        const deleted = await q(
          "DELETE FROM vendo_threads WHERE id = $1 AND subject = $2 RETURNING id",
          [id, principal.subject],
        );
        if (deleted.rows.length === 0) return;
        await q("DELETE FROM vendo_thread_messages WHERE thread_id = $1", [id]);
      });
    },

    /**
     * `ask_user`'s answer path (design §4), written as ONE statement so it
     * cannot open a cross-subject write.
     *
     * The threat this shape closes: an answer arrives from a client carrying a
     * thread id and a body. If either were trusted, one person could append to
     * another person's transcript — and because the transcript is what the next
     * turn reads, that is agent steering, not just defacement.
     *
     * Three properties, each enforced by the SQL rather than checked before it:
     *
     * 1. The INSERT's rows come from a SELECT over `vendo_threads` filtered by
     *    `subject = $4`. A thread that is not this principal's yields no row, so
     *    nothing is written and the empty RETURNING is the refusal. There is no
     *    read-then-write window for a foreign row to appear in.
     * 2. It can only ever APPEND to an existing thread. `vendo_thread_messages`
     *    has no default source of rows, so a nonexistent thread id cannot be
     *    conjured into existence by answering a question in it.
     * 3. `seq` is computed server-side as `max(seq) + 1` over that thread. A
     *    caller cannot choose where in someone's history their answer lands,
     *    which would otherwise let an answer be inserted BEFORE the question it
     *    supposedly answers.
     * 4. `FOR KEY SHARE OF t` — the ownership read LOCKS the thread row rather
     *    than merely reading it. One statement is not enough on its own: under
     *    READ COMMITTED a plain read still sees a row a concurrent
     *    `threadStore.delete` has removed but not yet committed, so the answer
     *    landed after that delete's message sweep and outlived the thread that
     *    owns it — unreachable forever, because a message row has no subject and
     *    no foreign key. With the lock the two orders are the only outcomes: the
     *    answer commits first and the cascade sweeps it, or the delete commits
     *    first and this statement finds no row and refuses below. KEY SHARE is
     *    the weakest strength that conflicts with deleting the row — the same
     *    lock a foreign key would take — so ordinary thread touches
     *    (`updated_at`, `revision`) still run alongside answers.
     *
     * The row id is `ans_<questionId>`, NOT the bare `questionId`. The prefix is
     * a namespace, and the in-lane security review is why it exists: the bare id
     * shared a primary key with every other message in the thread, so an answer
     * whose id happened to match an ordinary assistant message wrote nothing and
     * still reported success.
     *
     * It requires a WRITE RECEIPT. Returning quietly on an empty RETURNING was
     * the worst version of the same bug (verifier finding 5): a reused
     * `questionId` discarded the user's real answer and left an earlier one
     * standing as though it were theirs, with success reported to the model.
     * There is no safe way to treat that as idempotent, because the two answers
     * are not the same answer — so a reused id is refused, loudly, and the caller
     * mints a fresh one.
     */
    async recordAnswer(principal, { threadId, questionId, answer }) {
      const now = new Date().toISOString();
      const rowId = `ans_${questionId}`;
      const message = {
        id: rowId,
        role: "user",
        parts: [{ type: "data-vendo-ask-answer", data: answer }],
      };
      const result = await db.query(
        `INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
         SELECT t.id, $2,
                COALESCE((SELECT max(m.seq) + 1 FROM vendo_thread_messages m WHERE m.thread_id = t.id), 0),
                $3::jsonb, $5, $5
         FROM vendo_threads t WHERE t.id = $1 AND t.subject = $4
         FOR KEY SHARE OF t
         ON CONFLICT (thread_id, id) DO NOTHING
         RETURNING thread_id`,
        [threadId, rowId, JSON.stringify(message), principal.subject, now],
      );
      // A receipt is REQUIRED. Anything else means nothing was written, and this
      // function must never report success for an answer that does not exist.
      if (result.rows[0] !== undefined) return;
      // Empty RETURNING has two causes and they need different words: the thread
      // is not ours (or absent), or this questionId was already answered.
      const owned = await db.query(
        "SELECT 1 FROM vendo_threads WHERE id = $1 AND subject = $2",
        [threadId, principal.subject],
      );
      if (owned.rows[0] === undefined) {
        throw new VendoError("conflict", `thread ${threadId} does not belong to this subject`);
      }
      throw new VendoError(
        "conflict",
        `question ${JSON.stringify(questionId)} in thread ${threadId} was already answered; `
        + "an answer is never overwritten, so mint a fresh questionId for a new question",
      );
    },
  };
}

export type { ThreadRow } from "./types.js";

/** The ONE write path for a thread's harness continuity, shared by
 *  `ops.harness.set` and the batched turn commit so the two cannot drift.
 *
 *  `subject` is in the WHERE, not just the payload: the slot belongs to the
 *  thread's OWNER, so a call naming someone else's thread matches no row and is
 *  refused rather than silently landing on it. A missing row and a foreign row
 *  are deliberately the same answer — neither is a conversation this caller may
 *  bookmark, and telling them apart would confirm the thread exists.
 *
 *  `updated_at` and `revision` are untouched on purpose: resuming a session is
 *  not a message and not an edit, so it must not reshuffle a thread list or
 *  lose a concurrent caller's compare-and-swap. */
export async function setHarnessState(
  db: Db,
  threadId: string,
  subject: string,
  state: Json,
): Promise<void> {
  const result = await db.query(
    "UPDATE vendo_threads SET harness_state = $3::jsonb WHERE id = $1 AND subject = $2 RETURNING id",
    [threadId, subject, JSON.stringify(state)],
  );
  if (result.rows.length === 0) {
    throw new VendoError("not-found", `thread ${threadId} not found`);
  }
}
