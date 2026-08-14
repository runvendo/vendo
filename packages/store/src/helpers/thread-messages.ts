import { STORE_WIRE_APPEND_MESSAGES_OPS, VendoError, type Principal, type StoreOps, type ThreadId } from "@vendoai/core";
import type { Db } from "../db-postgres.js";
import type { VendoStore } from "../store.js";
import { backendOf } from "./backend.js";
import { appendThreadMessages } from "./rows.js";

/** The least a transcript row must have for this store to key it: an id.
 *
 *  Build contract §6 writes the surface in terms of the ai-SDK's `UIMessage`,
 *  and lane A's runtime instantiates it that way — `threadMessageStore<UIMessage>(store)`
 *  — so callers get the frozen signature exactly. The parameter stays generic
 *  here because `@vendoai/store` (like `@vendoai/core`) deliberately does not
 *  depend on `ai`: the store never interprets a message, only orders and
 *  returns it. Importing the type would put `ai` + a `zod` floor into the
 *  store's published peer set for one type annotation, which
 *  `scripts/dependency-guard.mjs` rejects outright. See the lane report. */
export interface ThreadMessageLike {
  id: string;
}

/** Build contract §6 — the surface, whichever backend serves it. */
export interface ThreadMessageStore<M extends ThreadMessageLike = ThreadMessageLike> {
  /** One row per message. Pass `expectedRevision` for a per-row CAS edit
   *  (contract §6): the write lands only if the row is still at that revision,
   *  so an edit built on a stale read is refused instead of clobbering a
   *  concurrent one. Omit it for last-write-wins, which is the default. */
  upsert(
    principal: Principal,
    threadId: ThreadId,
    message: M,
    seq: number,
    opts?: { expectedRevision?: number },
  ): Promise<void>;
  /** A whole turn's new-or-edited messages in ONE round trip, with `title` the
   *  listing title the caller derived. What `upsert` does per message — and,
   *  over the wire, per message plus a full thread download — this does once.
   *  A message the thread already holds is updated in place and keeps its
   *  position; genuinely new ones are appended after the tail, in the order
   *  given.
   *
   *  Unlike `upsert`, this takes NO `seq`: a caller computing a position
   *  outside the write cannot avoid racing another turn on the same thread for
   *  it (proven on PostgreSQL 17), so the position is the statement's to assign
   *  while it holds the thread row. */
  upsertMany(
    principal: Principal,
    threadId: ThreadId,
    messages: ReadonlyArray<M>,
    opts?: { title?: string },
  ): Promise<void>;
  /** Reassembled by seq, oldest → newest. */
  list(principal: Principal, threadId: ThreadId): Promise<M[]>;
}

/** One answer per StoreOps handle — i.e. once per process for the one hosted
 *  client a deployment builds — to "does this mount serve
 *  `transcripts.appendMessages`?". Weakly held so a per-request store handle
 *  cannot pin its client forever. */
const appendSupport = new WeakMap<StoreOps, Promise<boolean>>();

/**
 * The capability question, asked EXPLICITLY and answered before any write.
 *
 * `/status` is the wire's own discovery handshake, and the op count is the only
 * signal it carries; a mount reporting fewer than
 * STORE_WIRE_APPEND_MESSAGES_OPS predates the op. The shape is the one
 * `guard.previewCheck` uses (detect the capability, then choose a supported
 * route), and deliberately NOT a `catch` around a failed mutation: reading a
 * 501 as "fall back" is how a half-applied write gets retried down a second
 * path (#1251). A handshake that fails is not an answer — it is not cached and
 * it does not degrade; the write fails and the caller's retry asks again.
 */
async function servesAppendMessages(ops: StoreOps): Promise<boolean> {
  let answer = appendSupport.get(ops);
  if (answer === undefined) {
    answer = ops.status().then((status) => status.ops >= STORE_WIRE_APPEND_MESSAGES_OPS);
    answer.catch(() => appendSupport.delete(ops));
    appendSupport.set(ops, answer);
  }
  return await answer;
}

function requireMessageId(message: ThreadMessageLike): string {
  const messageId = message.id;
  if (typeof messageId !== "string" || messageId === "") {
    throw new VendoError("validation", "a thread message needs a non-empty id");
  }
  return messageId;
}

/** Build contract §6 — one row per transcript message.
 *
 *  Why this exists: rewriting a whole `messages` array on every turn is
 *  O(messages²) over a conversation. One row per message makes a turn's write
 *  O(new messages), which is the property E6 measures.
 *
 *  Two invariants both backends enforce rather than trust:
 *  - **`seq` is the only ordering authority.** Approval flips rewrite older
 *    messages, so `updated_at` does not order a transcript and is never read
 *    for ordering.
 *  - **Threads never cross subjects** (03 §5). The thread row is the ownership
 *    record; every read and write here joins it under `principal.subject`, so a
 *    foreign thread id reads as empty and writes to it are refused.
 */
export function threadMessageStore<M extends ThreadMessageLike = ThreadMessageLike>(
  store: VendoStore,
): ThreadMessageStore<M> {
  const backend = backendOf(store, "the per-message transcript (build contract §6)");
  return backend.kind === "ops" ? overOps<M>(backend.ops) : overSql<M>(backend.db);
}

/**
 * The hosted half (design D2): transcripts ride `vendo/store-wire@1` as-is —
 * `putMessage` for both the insert and the edit (an approval flip re-sends the
 * message under its own id, which is the wire's edit), `getThread` for the read.
 *
 * Two honest differences from the SQL half, neither of which the runtime's
 * caller can see:
 * - **`seq` is not sent.** The wire's `putMessage` carries no seq; the service
 *   appends at `max(seq) + 1`. `persistTurn` walks the canonical array in index
 *   order and writes only what changed, so appended order IS seq order.
 * - **Ownership is read-then-write**, not one statement. The TOCTOU window that
 *   opens is between two writes by the same subject to a thread whose owner
 *   would have to change mid-call, which the store has no verb for.
 *   `upsertMany` DOES have that verb (`transcripts.appendMessages` names the
 *   subject), so it closes both the window and the download — on a mount new
 *   enough to serve it.
 */
function overOps<M extends ThreadMessageLike>(ops: StoreOps): ThreadMessageStore<M> {
  /** The thread record is the ownership record on the wire exactly as the
   *  `vendo_threads` row is in SQL: `data.subject` is the same field the join
   *  reads. A foreign or absent thread yields nothing, so reads answer empty
   *  and writes refuse — mirroring the local empty-read. */
  const ownedThread = async (
    principal: Principal,
    threadId: ThreadId,
  ): Promise<{ messages?: unknown } | undefined> => {
    const record = await ops.transcripts.getThread(threadId);
    if (record === null) return undefined;
    const data = record.data as { subject?: unknown; messages?: unknown };
    return data.subject === principal.subject ? data : undefined;
  };

  return {
    async upsert(principal, threadId, message, _seq, opts) {
      requireMessageId(message);
      if (opts?.expectedRevision !== undefined) {
        // Deliberately loud rather than silently downgraded to last-write-wins:
        // a caller asking for CAS is asking not to clobber a concurrent edit.
        // `transcripts.putMessage` carries no revision, so the guarantee cannot
        // be honored over the wire — and no runtime caller asks for it.
        throw new VendoError(
          "not-implemented",
          "a per-row CAS transcript edit (expectedRevision) is not expressible over the store wire: "
          + "transcripts.putMessage carries no revision. Use a SQL-backed store for guarded edits.",
        );
      }
      if (await ownedThread(principal, threadId) === undefined) {
        throw new VendoError("conflict", `thread ${threadId} does not belong to this subject`);
      }
      await ops.transcripts.putMessage(threadId, message);
    },
    async upsertMany(principal, threadId, messages, opts) {
      if (messages.length === 0) return;
      for (const message of messages) requireMessageId(message);
      const append = ops.transcripts.appendMessages;
      if (append !== undefined && await servesAppendMessages(ops)) {
        await append(
          threadId,
          principal.subject,
          [...messages],
          { ...(opts?.title === undefined ? {} : { title: opts.title }) },
        );
        return;
      }
      // The mount predates the op. This is the ROUTE the feature detect chose
      // up front, not a rescue after a failed write: one ownership read, then
      // the per-message writes this helper has always made. The title is the
      // only thing it cannot carry (no wire verb sets it without rewriting the
      // whole thread), and it is derived from the first user message, which the
      // thread's creating write already stored. It also refuses a thread that
      // does not exist yet, where the op would create it — the harness persists
      // the row before any turn appends, so nothing rides on the difference.
      if (await ownedThread(principal, threadId) === undefined) {
        throw new VendoError("conflict", `thread ${threadId} does not belong to this subject`);
      }
      for (const message of messages) {
        await ops.transcripts.putMessage(threadId, message);
      }
    },
    async list(principal, threadId) {
      const data = await ownedThread(principal, threadId);
      if (data === undefined) return [];
      return Array.isArray(data.messages) ? data.messages as M[] : [];
    },
  };
}

/** The SQL half: the statements are the enforcement. */
function overSql<M extends ThreadMessageLike>(db: Db): ThreadMessageStore<M> {
  return {
    async upsert(principal, threadId, message, seq, opts) {
      // The ownership gate is the INSERT's own source of rows: the SELECT
      // yields nothing unless a vendo_threads row with this id belongs to this
      // subject, so a foreign (or absent) thread writes nothing and we refuse.
      // Doing it in ONE statement closes the TOCTOU window a read-then-write
      // pre-check leaves open (the same reasoning as putThreadRow's guarded
      // upsert), and it is why the answer cannot be "insert anyway".
      //
      // The insert leg LOCKS that row (`FOR KEY SHARE OF t`) rather than merely
      // reading it. One statement is not enough on its own: under READ COMMITTED
      // a plain read still sees a row a concurrent `threadStore.delete` has
      // removed but not yet committed, so the message landed after that
      // cascade's sweep and outlived its own thread — unreachable forever, since
      // a message row carries no subject and no foreign key. KEY SHARE is the
      // weakest strength that conflicts with deleting the row (the lock a
      // foreign key would take), so thread touches still run alongside writes.
      // The CAS leg below needs no lock: it is a plain UPDATE of an existing
      // message row, so a swept row makes it match nothing — it can refuse, but
      // it can never create a row the cascade has already passed.
      const messageId = requireMessageId(message);
      const expected = opts?.expectedRevision;
      const at = new Date().toISOString();
      // A CAS write is an EDIT, so it is a plain UPDATE rather than an upsert: it
      // must fail when the row is gone, not resurrect it. A stale reader whose
      // message was deleted meanwhile has to see that, and an insert-on-conflict
      // shape would silently re-create it. Both legs stay ONE statement, joined
      // to the thread row for ownership, so no read-then-write window exists.
      const result = expected === undefined
        ? await db.query(
          `INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
           SELECT t.id, $2, $3, $4::jsonb, $5, $5 FROM vendo_threads t
             WHERE t.id = $1 AND t.subject = $6
           FOR KEY SHARE OF t
           ON CONFLICT (thread_id, id) DO UPDATE
             SET seq = EXCLUDED.seq, message = EXCLUDED.message,
                 updated_at = EXCLUDED.updated_at,
                 revision = vendo_thread_messages.revision + 1
           RETURNING thread_id`,
          [threadId, messageId, seq, JSON.stringify(message), at, principal.subject],
        )
        : await db.query(
          `UPDATE vendo_thread_messages m
           SET seq = $3, message = $4::jsonb, updated_at = $5, revision = m.revision + 1
           FROM vendo_threads t
           WHERE m.thread_id = $1 AND m.id = $2
             AND t.id = m.thread_id AND t.subject = $6
             AND m.revision = $7::integer
           RETURNING m.thread_id`,
          [threadId, messageId, seq, JSON.stringify(message), at, principal.subject, expected],
        );
      if (result.rows[0] !== undefined) return;
      // Nothing was written. Three causes, and they deserve different words.
      const owned = await db.query(
        "SELECT 1 FROM vendo_threads WHERE id = $1 AND subject = $2",
        [threadId, principal.subject],
      );
      if (owned.rows[0] === undefined) {
        throw new VendoError("conflict", `thread ${threadId} does not belong to this subject`);
      }
      if (expected !== undefined) {
        throw new VendoError(
          "conflict",
          `message ${JSON.stringify(messageId)} in thread ${threadId} is no longer at revision ${expected}; `
          + "re-read it and re-apply the edit",
        );
      }
      // Owned, no expectation, still nothing written — the statement should have
      // landed, so surface it rather than pretending it did.
      throw new VendoError("conflict", `could not write message ${JSON.stringify(messageId)} to thread ${threadId}`);
    },
    async upsertMany(principal, threadId, messages, opts) {
      if (messages.length === 0) return;
      // The SAME statements the hosted half reaches through the wire op, on the
      // same rows: ownership is the thread upsert's guard, and the batch lands
      // in one transaction with it.
      await db.transaction(async (query) => {
        await appendThreadMessages({ ...db, query }, {
          threadId,
          subject: principal.subject,
          messages: messages.map((message) => ({ id: requireMessageId(message), message })),
          ...(opts?.title === undefined ? {} : { title: opts.title }),
        });
      });
    },
    async list(principal, threadId) {
      const result = await db.query(
        `SELECT m.message FROM vendo_thread_messages m
         JOIN vendo_threads t ON t.id = m.thread_id
         WHERE m.thread_id = $1 AND t.subject = $2
         -- (seq, id), matching THREAD_MESSAGES_AGGREGATE exactly. seq is assigned
         -- without a unique constraint, so ties happen; ordering by seq alone here
         -- meant this helper and the reserved-collection door could read one
         -- thread in two different orders.
         ORDER BY m.seq ASC, m.id ASC`,
        [threadId, principal.subject],
      );
      return result.rows.map((row) => row["message"] as M);
    },
  };
}
