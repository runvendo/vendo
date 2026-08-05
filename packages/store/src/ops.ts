import {
  VENDO_STORE_WIRE_FORMAT,
  VendoError,
  type FilesAdapter,
  type Json,
  type RecordStore,
  type StoreOps,
  type VendoRecord,
} from "@vendoai/core";
import type { Db, Query } from "./db.js";
import { eraseStore } from "./erase.js";
import { storeFiles, storeFilesForDb } from "./files-store.js";
import { harnessStateKey } from "./harness-state.js";
import { putStateRow, putThreadRow, THREAD_MESSAGES_AGGREGATE, threadFromRow } from "./helpers/rows.js";
import { adoptEphemeralSubject } from "./helpers/subjects.js";
import { iso, pageLimit, text } from "./helpers/utils.js";
import { createRecordStore } from "./records.js";
import { createReservedRecordStore, threadRecord } from "./routing.js";
import {
  claimEphemeralSubject,
  listStaleEphemeralSubjects,
  registerEphemeralSubject,
} from "./sessions.js";
import { dbFor, type VendoStore } from "./store.js";
import { invalid, parseThreadData, requireJson } from "./validate.js";
import { workspaceRows, type PreparedWrite } from "./workspace-rows.js";

/** The commit ledger's collection in the generic records table: one row per
 *  workspace.commit, which is what gives the verb its history entries, its
 *  undo unit, and its idempotency-key replay — no new table. Rows carry the
 *  workspace owner as a subject ref, so the erase cascade reaches them. */
const WORKSPACE_COMMITS = "vendo_workspace_commits";

interface WorkspaceEntry {
  path: string;
  data: unknown;
}

function parseWorkspaceEntries(entries: unknown[]): WorkspaceEntry[] {
  return entries.map((entry) => {
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path === "") invalid("workspace entry needs a non-empty path");
    if ((entry as { data?: unknown }).data === undefined) {
      invalid(`workspace entry ${path} needs data`);
    }
    return { path, data: (entry as { data: unknown }).data };
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 02-store — the LOCAL backend of the StoreOps named-operation contract
 * (core/store.ts): the 32 ops served straight off this store's own Postgres,
 * through the EXISTING helpers — routing doors, thread rows, workspace rows,
 * erase/adopt cascades, session registry. Logic unchanged; what this layer
 * adds is the atomic scope: every multi-statement verb runs inside ONE
 * `Db.transaction()`, so the operation manifest's verb boundaries hold under
 * a crash (F4's orphaned thread messages being the founding example).
 */
export function createStoreOps(
  store: VendoStore,
  options: { files?: FilesAdapter; workspaceOwner?: string } = {},
): StoreOps {
  const db = dbFor(store);
  /** Workspace verbs carry no subject on the contract — the backend is bound
   *  to its caller's mount at construction (the cloud door binds per tenant). */
  const owner = options.workspaceOwner ?? "user_local";

  /** The helpers all speak Db but only ever call `query`, so a verb's
   *  transaction hands them the same handle with the tx-scoped query in it. */
  const txDb = (query: Query): Db => ({ ...db, query });

  /** Blobs touched INSIDE a verb's transaction must ride the tx query: the
   *  store-backed files adapter is a vendo_blobs row, and PGlite's single
   *  connection queues (deadlocks) a base-handle query issued mid-transaction.
   *  A host-wired adapter (S3) is external either way — the honest blob saga. */
  const filesFor = (d: Db): FilesAdapter => options.files ?? storeFilesForDb(d);
  const files = options.files ?? storeFiles(store);

  const recordsDoor = (d: Db, collection: string): RecordStore =>
    createReservedRecordStore(d, collection) ?? createRecordStore(d, collection);

  /** Reassemble one thread as its door record (shared read shape). */
  const readThread = async (d: Db, id: string): Promise<VendoRecord | null> => {
    const result = await d.query(
      `SELECT t.*, ${THREAD_MESSAGES_AGGREGATE("t")} AS messages FROM vendo_threads t WHERE t.id = $1`,
      [id],
    );
    return result.rows[0] ? threadRecord(threadFromRow(result.rows[0])) : null;
  };

  /** Append one message row to an existing thread: the INSERT's rows come from
   *  a SELECT over vendo_threads, so an absent thread writes nothing (the same
   *  structural gate as helpers/thread-messages); seq is assigned server-side. */
  const appendMessage = async (
    q: Query,
    threadId: string,
    rowId: string,
    message: unknown,
    now: string,
  ): Promise<boolean> => {
    const result = await q(
      `INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
       SELECT t.id, $2,
              COALESCE((SELECT max(m.seq) + 1 FROM vendo_thread_messages m WHERE m.thread_id = t.id), 0),
              $3::jsonb, $4, $4
       FROM vendo_threads t WHERE t.id = $1
       ON CONFLICT (thread_id, id) DO NOTHING
       RETURNING thread_id`,
      [threadId, rowId, JSON.stringify(message), now],
    );
    return result.rows[0] !== undefined;
  };

  /** Every message write is a thread write (same token discipline as the doors). */
  const touchThread = async (q: Query, threadId: string, now: string): Promise<void> => {
    await q(
      "UPDATE vendo_threads SET updated_at = $2, revision = revision + 1 WHERE id = $1",
      [threadId, now],
    );
  };

  return {
    // -----------------------------------------------------------------------
    // records — the routed doors, verbatim; per-collection policy lives there.
    // -----------------------------------------------------------------------
    records: {
      async get(collection, id) {
        return await recordsDoor(db, collection).get(id);
      },
      async put(collection, record) {
        return await db.transaction((q) => recordsDoor(txDb(q), collection).put(record));
      },
      async delete(collection, id) {
        await db.transaction((q) => recordsDoor(txDb(q), collection).delete(id));
      },
      async list(collection, query) {
        return await recordsDoor(db, collection).list(query);
      },
      async claim(collection, expected, replacement) {
        return await db.transaction(async (q) => {
          const door = recordsDoor(txDb(q), collection);
          if (door.claim === undefined) {
            throw new VendoError("not-implemented", `${collection} does not support claim`);
          }
          return await door.claim(expected, replacement);
        });
      },
      async insertIfAbsent(collection, record) {
        return await db.transaction(async (q) => {
          const door = recordsDoor(txDb(q), collection);
          if (door.atomic === undefined) {
            throw new VendoError("not-implemented", `${collection} does not support insertIfAbsent`);
          }
          return await door.atomic.insertIfAbsent(record);
        });
      },
      async compareAndSwap(collection, record, expectedRevision) {
        return await db.transaction(async (q) => {
          const door = recordsDoor(txDb(q), collection);
          if (door.atomic === undefined) {
            throw new VendoError("not-implemented", `${collection} does not support compareAndSwap`);
          }
          return await door.atomic.compareAndSwap(record, expectedRevision);
        });
      },
    },

    // -----------------------------------------------------------------------
    // blobs — single-statement verbs; the store's own blob door as-is.
    // -----------------------------------------------------------------------
    blobs: {
      async put(namespace, key, bytes, meta) {
        await store.blobs(namespace).put(key, bytes, meta);
      },
      async get(namespace, key) {
        return await store.blobs(namespace).get(key);
      },
      async delete(namespace, key) {
        await store.blobs(namespace).delete(key);
      },
      async list(namespace, prefix) {
        return await store.blobs(namespace).list(prefix);
      },
    },

    // -----------------------------------------------------------------------
    // transcripts
    // -----------------------------------------------------------------------
    transcripts: {
      /** Thread row + full message replace in ONE transaction. */
      async putThread(thread) {
        const data = parseThreadData(
          {
            subject: thread.subject,
            messages: thread.messages,
            ...(thread.title === undefined ? {} : { title: thread.title }),
          },
          thread.id,
        );
        const row = await db.transaction((q) => putThreadRow(txDb(q), { id: thread.id, ...data }));
        return threadRecord(row);
      },
      async getThread(id) {
        return await readThread(db, id);
      },
      async listThreads(query) {
        return await recordsDoor(db, "vendo_threads").list({
          ...(query?.subject === undefined ? {} : { refs: { subject: query.subject } }),
          ...(query?.limit === undefined ? {} : { limit: query.limit }),
          ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        });
      },
      /** F4 — the delete is a cascade: thread + its message rows + its harness
       *  state die together, in ONE transaction. (threadStore.delete left the
       *  v6 message rows behind; this verb ends that.) */
      async deleteThread(id) {
        await db.transaction(async (q) => {
          await q("DELETE FROM vendo_thread_messages WHERE thread_id = $1", [id]);
          await q("DELETE FROM vendo_threads WHERE id = $1", [id]);
          await q("DELETE FROM vendo_state WHERE app_id = $1", [harnessStateKey(id)]);
        });
      },
      async putMessage(threadId, message) {
        const given = (message as { id?: unknown } | null)?.id;
        const rowId = typeof given === "string" && given !== ""
          ? given
          : `msg_${globalThis.crypto.randomUUID()}`;
        return await db.transaction(async (q) => {
          const now = new Date().toISOString();
          if (!(await appendMessage(q, threadId, rowId, message, now))) {
            // The id already holds a row (an edit), or the thread is absent.
            const updated = await q(
              `UPDATE vendo_thread_messages SET message = $3::jsonb, updated_at = $4, revision = revision + 1
               WHERE thread_id = $1 AND id = $2 RETURNING thread_id`,
              [threadId, rowId, JSON.stringify(message), now],
            );
            if (updated.rows[0] === undefined) {
              throw new VendoError("not-found", `thread ${threadId} not found`);
            }
          }
          await touchThread(q, threadId, now);
          const record = await readThread(txDb(q), threadId);
          if (record === null) throw new VendoError("not-found", `thread ${threadId} not found`);
          return record;
        });
      },
      /** Deliberately non-idempotent: a duplicate answer id is refused loudly —
       *  two answers are never the same answer (helpers/threads.recordAnswer). */
      async recordAnswer(threadId, answer) {
        const embedded = (answer as { id?: unknown } | null)?.id;
        const answerId = typeof embedded === "string" && embedded !== ""
          ? embedded
          : JSON.stringify(answer);
        const rowId = `ans_${answerId}`;
        const message = {
          id: rowId,
          role: "user",
          parts: [{ type: "data-vendo-ask-answer", data: answer }],
        };
        return await db.transaction(async (q) => {
          const now = new Date().toISOString();
          if (!(await appendMessage(q, threadId, rowId, message, now))) {
            const owned = await q("SELECT 1 FROM vendo_threads WHERE id = $1", [threadId]);
            if (owned.rows[0] === undefined) {
              throw new VendoError("not-found", `thread ${threadId} not found`);
            }
            throw new VendoError(
              "conflict",
              `answer ${JSON.stringify(answerId)} in thread ${threadId} was already recorded; `
              + "an answer is never overwritten, so mint a fresh id for a new answer",
            );
          }
          await touchThread(q, threadId, now);
          const record = await readThread(txDb(q), threadId);
          if (record === null) throw new VendoError("not-found", `thread ${threadId} not found`);
          return record;
        });
      },
    },

    // -----------------------------------------------------------------------
    // harness — the vendo_state slot, keyed by (appId, subject) exactly as the
    // routed `vendo_state` door and stateStore key it, through the same single
    // write path (helpers/rows putStateRow) so the three doors cannot drift.
    // Every verb here is one statement, so none of them opens a transaction.
    // -----------------------------------------------------------------------
    harness: {
      async get(appId, subject) {
        const result = await db.query(
          "SELECT data FROM vendo_state WHERE app_id = $1 AND subject = $2",
          [appId, subject],
        );
        const row = result.rows[0]?.["data"];
        if (row === undefined) return null;
        return typeof row === "string" ? (JSON.parse(row) as unknown) : row;
      },
      async set(appId, subject, state) {
        await putStateRow(db, { appId, subject, data: requireJson(state, "harness state") });
      },
      async clear(appId, subject) {
        await db.query(
          "DELETE FROM vendo_state WHERE app_id = $1 AND subject = $2",
          [appId, subject],
        );
      },
    },

    // -----------------------------------------------------------------------
    // workspace — the row helpers under a commit unit. Content staging (the
    // blob leg for big files) happens BEFORE the transaction and is
    // compensated by discard; the row swaps (the existing CTE, verbatim via
    // workspaceRows.land) and the commit-ledger write share ONE transaction.
    // -----------------------------------------------------------------------
    workspace: {
      async index(query) {
        const limit = pageLimit(query?.limit);
        const params: unknown[] = [owner];
        let where = "owner = $1";
        if (query?.cursor !== undefined) {
          params.push(query.cursor);
          where += " AND path > $2";
        }
        params.push(limit + 1);
        const result = await db.query(
          `SELECT path, bytes, revision, updated_at FROM vendo_workspace_files
           WHERE ${where} ORDER BY path ASC LIMIT $${params.length}`,
          params,
        );
        const entries = result.rows.slice(0, limit).map((row) => ({
          path: text(row["path"]),
          bytes: Number(row["bytes"]),
          revision: Number(row["revision"]),
          updatedAt: iso(row["updated_at"]),
        }));
        return {
          entries,
          ...(result.rows.length > limit && entries.length > 0
            ? { cursor: entries[entries.length - 1]!.path }
            : {}),
        };
      },
      async read(paths) {
        const rows = workspaceRows(db, files);
        const result: Record<string, unknown> = {};
        for (const path of paths) {
          const bytes = await rows.read(owner, path);
          if (bytes === undefined) continue;
          result[path] = JSON.parse(decoder.decode(bytes));
        }
        return result;
      },
      async commit(entries, opts) {
        const parsed = parseWorkspaceEntries(entries);
        const body = JSON.stringify(parsed);
        const key = opts?.idempotencyKey;
        // The ledger row id derives from the key, so the key IS the claim.
        const commitId = key === undefined
          ? `wsc_${globalThis.crypto.randomUUID()}`
          : `wsc_key_${key}`;
        const rows = workspaceRows(db, files);
        // Stage: place every entry's content (inline decided, blob uploaded)
        // before any row is touched — the saga's only non-transactional leg.
        const prepared: Array<{ path: string; write: PreparedWrite | "unchanged" }> = [];
        const discardAll = async (): Promise<void> => {
          for (const staged of prepared) {
            if (staged.write !== "unchanged") await rows.discard(staged.write);
          }
        };
        let replayed: boolean | undefined;
        try {
          for (const entry of parsed) {
            prepared.push({
              path: entry.path,
              write: await rows.prepare(owner, entry.path, encoder.encode(JSON.stringify(entry.data))),
            });
          }
          replayed = await db.transaction(async (q) => {
            const tdb = txDb(q);
            const ledger = createRecordStore(tdb, WORKSPACE_COMMITS);
            const created = prepared
              .filter((staged) => staged.write !== "unchanged" && staged.write.prior === undefined)
              .map((staged) => staged.path);
            // Claim the ledger row BEFORE touching any workspace row: the
            // (collection, id) unique key is the serialization point, so of
            // two same-key racers exactly one lands — the loser conflicts on
            // the insert instead of applying a second, different mutation.
            const claimed = await ledger.atomic!.insertIfAbsent({
              id: commitId,
              data: { body, entries: parsed as unknown as Json, created },
              refs: { subject: owner, ...(key === undefined ? {} : { key }) },
            });
            if (claimed === null) {
              const existing = await ledger.get(commitId);
              return (existing?.data as { body?: unknown } | undefined)?.body === body;
            }
            const txRows = workspaceRows(tdb, filesFor(tdb));
            for (const staged of prepared) {
              if (staged.write === "unchanged") continue;
              await txRows.land(owner, staged.write, commitId);
            }
            return undefined;
          });
        } catch (error) {
          // Compensation: a commit that did not land releases what it staged.
          await discardAll();
          throw error;
        }
        if (replayed === undefined) return; // landed
        // A replay never lands its staging — recorded result stands.
        await discardAll();
        if (!replayed) {
          throw new VendoError(
            "conflict",
            `idempotency key ${JSON.stringify(key)} was already used for different entries`,
          );
        }
      },
      async history(query) {
        const page = await createRecordStore(db, WORKSPACE_COMMITS).list({
          refs: { subject: owner },
          ...(query?.limit === undefined ? {} : { limit: query.limit }),
          ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return {
          entries: page.records.map((record) => ({
            commitId: record.id,
            entries: (record.data as { entries?: unknown }).entries ?? [],
          })),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      },
      /** Land the restore and consume the history it walked in ONE transaction. */
      async undo(commitId) {
        await db.transaction(async (q) => {
          const tdb = txDb(q);
          const ledger = createRecordStore(tdb, WORKSPACE_COMMITS);
          const commit = await ledger.get(commitId);
          if (commit === null) {
            throw new VendoError("not-found", `commit ${commitId} not found`);
          }
          const data = commit.data as { entries?: WorkspaceEntry[]; created?: string[] };
          const created = new Set(data.created ?? []);
          const txRows = workspaceRows(tdb, filesFor(tdb));
          for (const entry of data.entries ?? []) {
            if (created.has(entry.path)) {
              // The commit created this path — undoing removes it (recorded to
              // history, §3.3's append-only law, so it stays recoverable).
              await txRows.remove(owner, entry.path, `undo ${commitId}`);
            } else {
              await txRows.undo(owner, entry.path);
            }
          }
          await ledger.delete(commitId);
        });
      },
    },

    // -----------------------------------------------------------------------
    // lifecycle
    // -----------------------------------------------------------------------
    lifecycle: {
      /** The 21-table erase saga, as-is: re-runnable, real-deletion report.
       *  Deliberately NOT one transaction — blob deletion is external work. */
      async erase(target) {
        const doors = eraseStore(store, { files });
        if (target.subject !== undefined) return await doors.bySubject(target.subject);
        if (target.appId !== undefined) return await doors.byApp(target.appId);
        invalid("lifecycle.erase needs a subject or an appId");
      },
      /** Session-claim linearizes (inside adoptEphemeralSubject), then merge.
       *  The contract moves the WHOLE identity, so the two axes the BYO helper
       *  leaves alone follow here: generic door rows keyed by a subject ref,
       *  and the session registration itself (it re-registers under `to` at
       *  the original touch time). */
      async adopt(from, to) {
        const touched = await db.query(
          "SELECT touched_at FROM vendo_sessions WHERE subject = $1",
          [from],
        );
        const report = await adoptEphemeralSubject(store, from, to, { files });
        if (report === null) return null;
        await db.query(
          `UPDATE vendo_records SET refs = refs || jsonb_build_object('subject', $2::text)
           WHERE refs @> jsonb_build_object('subject', $1::text)`,
          [from, to],
        );
        const touchedAt = touched.rows[0]?.["touched_at"];
        if (touchedAt !== undefined) {
          await registerEphemeralSubject(store, to, Date.parse(iso(touchedAt)));
        }
        return report;
      },
      /** §9.5 — the app row flip and the workspace document move, which the
       *  umbrella ran as a two-step seam, are ONE transaction here. */
      async promote(appId, orgId) {
        await db.transaction(async (q) => {
          const tdb = txDb(q);
          const current = await q("SELECT subject FROM vendo_apps WHERE id = $1", [appId]);
          const from = current.rows[0]?.["subject"];
          if (typeof from !== "string") {
            throw new VendoError("not-found", `App ${appId} was not found`);
          }
          if (from === orgId) return; // already the org's — idempotent
          await workspaceRows(tdb, filesFor(tdb)).moveApp(
            appId,
            { kind: "user", subject: from },
            { kind: "org", org: orgId },
          );
          // The row flip, guarded on the current subject (appStore.promote's
          // statement): every vendo_apps write door bumps the token.
          const flipped = await q(
            `UPDATE vendo_apps SET subject = $3, updated_at = $4, revision = revision + 1
             WHERE id = $1 AND subject = $2 RETURNING id`,
            [appId, from, orgId, new Date().toISOString()],
          );
          if (flipped.rows[0] === undefined) {
            throw new VendoError("conflict", `app ${appId} belongs to another subject`);
          }
        });
      },
      async sessionRegister(subject, now) {
        await registerEphemeralSubject(store, subject, now);
      },
      async sessionStale(idleMs, now) {
        return await listStaleEphemeralSubjects(store, {
          idleMs,
          ...(now === undefined ? {} : { now }),
        });
      },
      async sessionClaim(subject, idleMs, now) {
        return await claimEphemeralSubject(store, subject, {
          idleMs,
          ...(now === undefined ? {} : { now }),
        });
      },
    },

    async status() {
      return { format: VENDO_STORE_WIRE_FORMAT, ops: 32 };
    },
  };
}
