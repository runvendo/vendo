/**
 * DrizzleThreadStore — durable port of the core `ThreadStore` seam
 * (packages/flowlet-core/src/seams/store.ts). Behavioral spec:
 * InMemoryThreadStore (packages/flowlet-runtime/src/embedded/in-memory-store.ts).
 *
 * Seq allocation is race-safe: `threads.nextSeq` is reserved with an atomic
 * `UPDATE ... SET next_seq = next_seq + n RETURNING next_seq` inside a
 * transaction, never `MAX(seq)+1` (which double-allocates under concurrency —
 * see the Task 9 plan note). `upsertMessages` reserves seqs ONLY for messages
 * that are genuinely new; pre-existing message ids are updated in place
 * (message column only — their seq, and therefore position, never moves).
 * Existing-vs-new is resolved inside the same transaction as the reservation,
 * so two concurrent upserts of disjoint message ids always get disjoint seq
 * ranges without ever touching the `thread_messages_seq_uq` index twice for
 * the same value (a single INSERT ... ON CONFLICT covering both new and
 * pre-existing rows would risk exactly that: passing an existing row's own
 * seq back through the VALUES list can collide with the seq-uniqueness index,
 * which isn't the ON CONFLICT arbiter and so isn't suppressed — Postgres still
 * raises 23505 for a violation on a non-arbiter unique index. Splitting the
 * write into "plain UPDATE for existing ids" + "plain INSERT of freshly
 * reserved seqs for new ids" avoids that path entirely.)
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FlowletUIMessage, Principal, ThreadRecord, ThreadStore } from "@flowlet/core";
import type { FlowletDb } from "./db.js";
import { threadMessages, threads } from "./schema.js";
import { toIso } from "./automation-store.js";

type Db = FlowletDb["db"];
type ThreadRow = typeof threads.$inferSelect;

function rowToThread(row: ThreadRow): ThreadRecord {
  const record: ThreadRecord = {
    id: row.id,
    tenantId: row.tenantId,
    subject: row.subject,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  if (row.title != null) record.title = row.title;
  return record;
}

export function createDrizzleThreadStore(
  handle: FlowletDb,
  opts: { now?: () => string } = {},
): ThreadStore {
  const db = handle.db;
  const now = opts.now ?? (() => new Date().toISOString());

  function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return handle.db.transaction((tx) => fn(tx as unknown as Db));
  }

  async function selectThreadRow(
    tx: Db,
    scope: Principal,
    threadId: string,
  ): Promise<ThreadRow | undefined> {
    const rows = await tx
      .select()
      .from(threads)
      .where(
        and(eq(threads.tenantId, scope.tenantId), eq(threads.subject, scope.subject), eq(threads.id, threadId)),
      );
    return rows[0];
  }

  /** Atomically reserves `n` seqs on the thread row and returns the first one
   *  in the reserved block. Raw SQL (like `claimPendingApproval` in
   *  automation-store.ts) because drizzle's `.returning()` doesn't type-check
   *  cleanly against the pglite/node-postgres union `Db` bridge type. */
  async function reserveSeqs(tx: Db, scope: Principal, threadId: string, n: number, at: string): Promise<number> {
    const result = await tx.execute(sql`
      UPDATE flowlet.threads
      SET next_seq = next_seq + ${n}, updated_at = ${at}
      WHERE tenant_id = ${scope.tenantId} AND subject = ${scope.subject} AND id = ${threadId}
      RETURNING next_seq
    `);
    const rows = (result as unknown as { rows: Array<{ next_seq: number }> }).rows;
    const reserved = rows[0]?.next_seq ?? n;
    return reserved - n;
  }

  return {
    async create(scope: Principal, init: { title?: string } = {}): Promise<ThreadRecord> {
      const id = randomUUID();
      const createdAt = now();
      await db.insert(threads).values({
        id,
        tenantId: scope.tenantId,
        subject: scope.subject,
        title: init.title ?? null,
        nextSeq: 0,
        createdAt,
        updatedAt: createdAt,
      });
      const record: ThreadRecord = {
        id,
        tenantId: scope.tenantId,
        subject: scope.subject,
        createdAt,
        updatedAt: createdAt,
      };
      if (init.title !== undefined) record.title = init.title;
      return record;
    },

    async get(scope: Principal, threadId: string): Promise<ThreadRecord | undefined> {
      const row = await selectThreadRow(db, scope, threadId);
      return row ? rowToThread(row) : undefined;
    },

    async list(scope: Principal): Promise<ThreadRecord[]> {
      const rows = await db
        .select()
        .from(threads)
        .where(and(eq(threads.tenantId, scope.tenantId), eq(threads.subject, scope.subject)));
      return rows.map(rowToThread);
    },

    async appendMessages(
      scope: Principal,
      threadId: string,
      messages: FlowletUIMessage[],
    ): Promise<void> {
      const owned = await selectThreadRow(db, scope, threadId);
      if (!owned) {
        throw new Error(`unknown thread "${threadId}" for scope ${scope.tenantId}/${scope.subject}`);
      }
      if (messages.length === 0) return;
      await withTransaction(async (tx) => {
        const at = now();
        const startSeq = await reserveSeqs(tx, scope, threadId, messages.length, at);
        await tx.insert(threadMessages).values(
          messages.map((m, i) => ({
            tenantId: scope.tenantId,
            subject: scope.subject,
            threadId,
            messageId: m.id,
            seq: startSeq + i,
            message: m,
          })),
        );
      });
    },

    async getMessages(scope: Principal, threadId: string): Promise<FlowletUIMessage[]> {
      const rows = await db
        .select()
        .from(threadMessages)
        .where(
          and(
            eq(threadMessages.tenantId, scope.tenantId),
            eq(threadMessages.subject, scope.subject),
            eq(threadMessages.threadId, threadId),
          ),
        )
        .orderBy(threadMessages.seq);
      return rows.map((row) => row.message as FlowletUIMessage);
    },

    async upsertMessages(
      scope: Principal,
      threadId: string,
      messages: FlowletUIMessage[],
    ): Promise<void> {
      if (messages.length === 0) return;
      await withTransaction(async (tx) => {
        const at = now();
        const existingThread = await selectThreadRow(tx, scope, threadId);
        if (!existingThread) {
          // The client owns thread ids for upsert (ai-SDK resume writes before
          // any explicit create() call) — an unrecognized threadId is a
          // first-write, not an error. `onConflictDoNothing` guards the (rare)
          // race of two concurrent first-writes to the same unknown id.
          await tx
            .insert(threads)
            .values({
              id: threadId,
              tenantId: scope.tenantId,
              subject: scope.subject,
              nextSeq: 0,
              createdAt: at,
              updatedAt: at,
            })
            .onConflictDoNothing();
        }

        const ids = messages.map((m) => m.id);
        const existingRows = await tx
          .select({ messageId: threadMessages.messageId })
          .from(threadMessages)
          .where(
            and(
              eq(threadMessages.tenantId, scope.tenantId),
              eq(threadMessages.subject, scope.subject),
              eq(threadMessages.threadId, threadId),
              inArray(threadMessages.messageId, ids),
            ),
          );
        const existingIds = new Set(existingRows.map((r) => r.messageId));
        const existingMessages = messages.filter((m) => existingIds.has(m.id));
        const newMessages = messages.filter((m) => !existingIds.has(m.id));

        // Update pre-existing rows in place: message column only, seq (and
        // therefore position) is never touched.
        for (const m of existingMessages) {
          await tx
            .update(threadMessages)
            .set({ message: m })
            .where(
              and(
                eq(threadMessages.tenantId, scope.tenantId),
                eq(threadMessages.subject, scope.subject),
                eq(threadMessages.threadId, threadId),
                eq(threadMessages.messageId, m.id),
              ),
            );
        }

        if (newMessages.length > 0) {
          const startSeq = await reserveSeqs(tx, scope, threadId, newMessages.length, at);
          await tx.insert(threadMessages).values(
            newMessages.map((m, i) => ({
              tenantId: scope.tenantId,
              subject: scope.subject,
              threadId,
              messageId: m.id,
              seq: startSeq + i,
              message: m,
            })),
          );
        } else {
          // Still bump updatedAt even when nothing new was reserved.
          await tx
            .update(threads)
            .set({ updatedAt: at })
            .where(
              and(
                eq(threads.tenantId, scope.tenantId),
                eq(threads.subject, scope.subject),
                eq(threads.id, threadId),
              ),
            );
        }
      });
    },
  };
}
