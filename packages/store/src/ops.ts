import {
  assertEngineCollection,
  VENDO_STORE_WIRE_FORMAT,
  VendoError,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
  type FilesAdapter,
  type Json,
  type RecordStore,
  type StoreOps,
  type VendoRecord,
} from "@vendoai/core";
import { appDataFiles, appDataRows } from "./app-data-rows.js";
import { backfillAppDataOnDb, reownAppData } from "./backfill-app-data.js";
import type { Db, Query } from "./db.js";
import { eraseStore } from "./erase.js";
import { storeFiles, storeFilesForDb } from "./files-store.js";
import { collectionFootprints } from "./footprint.js";
import { harnessStateKey } from "./harness-state.js";
import { appendThreadMessages, putStateRow, putThreadRow, THREAD_MESSAGES_AGGREGATE, threadFromRow } from "./helpers/rows.js";
import { cursorMs, decodeCursor, encodeCursor, iso, jsonParam, pageLimit, text } from "./helpers/utils.js";
import { createRecordStore } from "./records.js";
import { createReservedRecordStore, threadRecord, watermarkPage } from "./routing.js";
import { secretStore, storeSecrets } from "./secrets.js";
import { dbFor, type VendoStore } from "./store.js";
import { invalid, parseThreadData, requireJson } from "./validate.js";
import { workspaceRows, type PreparedWrite } from "./workspace-rows.js";

/** The commit ledger's collection in the generic records table: one row per
 *  workspace.commit, which is what gives the verb its history entries and its
 *  idempotency-key replay — no new table. Rows carry the workspace owner as a
 *  subject ref, so the erase cascade reaches them. */
const WORKSPACE_COMMITS = "vendo_workspace_commits";

/** The per-app bearer's collection in the generic records table: one row per
 *  live app token, `refs = { app_id, subject }`, minted and read by
 *  `packages/apps/src/server/persistence/app-token.ts` — the source of truth
 *  for this name. Spelled here rather than imported: `@vendoai/apps`'s entry is
 *  the whole apps server, and dragging it into this module's graph for one
 *  string costs the store its edge portability. */
const APP_TOKENS = "vendo_app_tokens";

interface WorkspaceEntry {
  path: string;
  data?: unknown;
  /** A tombstone: the commit removes this path (history keeps the content it
   *  removed, because the trail is append-only). */
  delete?: true;
  /** Strict compare-and-swap against the revision the caller read — the
   *  `/orgs` mounts' commit policy. A stale one refuses the WHOLE commit.
   *  `null` is the create-only guard: the caller read nothing at this path, so
   *  the commit must lose to whoever created it first. The absent field is
   *  unguarded. */
  expectedRevision?: number | null;
}

function parseWorkspaceEntries(entries: unknown[]): WorkspaceEntry[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path === "") invalid("workspace entry needs a non-empty path");
    const tombstone = (entry as { delete?: unknown }).delete === true;
    if (!tombstone && (entry as { data?: unknown }).data === undefined) {
      invalid(`workspace entry ${path} needs data`);
    }
    const expectedRevision = (entry as { expectedRevision?: unknown }).expectedRevision;
    if (expectedRevision !== undefined
      && expectedRevision !== null
      && typeof expectedRevision !== "number") {
      invalid(`workspace entry ${path} has a non-numeric expectedRevision`);
    }
    // One commit, one mutation per path. Two entries for the same path leave a
    // commit with no single before-image, so the path's trail would name two
    // superseded revisions under one commit id and neither would be THE one it
    // replaced. There is nothing a duplicate expresses that a second commit
    // does not, so it is caller nonsense and says so.
    if (seen.has(path)) invalid(`workspace entry ${path} appears twice in one commit`);
    seen.add(path);
    return {
      path,
      ...(tombstone ? { delete: true as const } : { data: (entry as { data: unknown }).data }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    };
  });
}

/** The revisions a set of paths currently hold, absent for a path with no row —
 *  the compare half of a strict commit for the entries `land` never sees. */
async function headRevisions(db: Db, owner: string, paths: string[]): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map();
  const result = await db.query(
    `SELECT path, revision FROM vendo_workspace_files WHERE owner = $1 AND path = ANY($2::text[])`,
    [owner, paths],
  );
  return new Map(result.rows.map((row) => [text(row["path"]), Number(row["revision"])]));
}

const commitEntries = (commit: VendoRecord): WorkspaceEntry[] =>
  (commit.data as { entries?: WorkspaceEntry[] }).entries ?? [];

const commitTouches = (commit: VendoRecord, path: string): boolean =>
  commitEntries(commit).some((entry) => entry.path === path);

/** `audit.list`'s statement (01 §12 `AuditQuery`). `kind` and `venue` are real
 *  columns; `outcome` and `decidedBy` are not — they live inside the stored
 *  event, so they are read out of the jsonb. Every filter is optional and they
 *  AND together, so an empty query is the whole feed.
 *
 *  The ordering and the cursor are the routed `vendo_audit` door's, verbatim
 *  (cursorMs, ORDER BY the truncated instant then id, over-fetch by one): both
 *  doors read the same rows, so a cursor minted by one has to keep meaning the
 *  same place in the other. */
async function auditPage(db: Db, query: AuditQuery): Promise<AuditPage> {
  const limit = pageLimit(query.limit);
  const params: unknown[] = [];
  const clauses: string[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (query.kind !== undefined) add("kind = ?", query.kind);
  if (query.venue !== undefined) add("venue = ?", query.venue);
  if (query.outcome !== undefined) add("event->>'outcome' = ?", query.outcome);
  if (query.decidedBy !== undefined) add("event->>'decidedBy' = ?", query.decidedBy);
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    params.push(cursor.c, cursor.i);
    clauses.push(`(${cursorMs("at")}, id) < (${cursorMs(`$${params.length - 1}::timestamptz`)}, $${params.length})`);
  }
  params.push(limit + 1);
  const result = await db.query(
    `SELECT id, at, event FROM vendo_audit${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY ${cursorMs("at")} DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    // The typed events, not records: the drawer stores AuditEvents and every
    // consumer casts a record's data straight back to one.
    events: page.map((row) => row["event"] as AuditEvent),
    ...(result.rows.length > limit && last
      ? { cursor: encodeCursor(iso(last["at"]), text(last["id"])) }
      : {}),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 02-store — the LOCAL backend of the StoreOps named-operation contract
 * (core/store.ts): the 42 ops served straight off this store's own Postgres,
 * through the EXISTING helpers — routing doors, thread rows, workspace rows, the
 * erase cascade. Logic unchanged; what this layer adds is the atomic scope:
 * every multi-statement verb runs inside ONE
 * `Db.transaction()`, so the operation manifest's verb boundaries hold under
 * a crash (F4's orphaned thread messages being the founding example).
 */
export function createStoreOps(
  store: VendoStore,
  options: { files?: FilesAdapter; workspaceOwner?: string } = {},
): StoreOps {
  const db = dbFor(store);
  /** Whose drawer a workspace verb addresses. The call names it when the mount
   *  serves more than one user (`/user/**` is the subject's, `/orgs/<org>/**`
   *  the org's); with no owner on the call the backend falls back to the one it
   *  was bound to at construction — today's single-player default. */
  const boundOwner = options.workspaceOwner ?? "user_local";
  const ownerFor = (opts?: { owner?: string }): string => opts?.owner ?? boundOwner;

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

  /** The secrets family IS the existing vault (secrets.ts): at-rest encryption,
   *  the dev-mode plaintext envelope and the fail-closed refusal without a key
   *  are all its, and nothing about them is re-decided here. */
  const secretReader = storeSecrets(store);
  const secretWriter = secretStore(store);

  /** commit id → the revision that commit superseded at `path`. Every write a
   *  commit lands stamps the commit id as its intent, so the workspace history
   *  rows ARE this index; a commit with no row here created the path (or wrote
   *  the bytes it already held), and has no older version behind it. */
  const supersededRevisions = async (owner: string, path: string): Promise<Map<string, number>> => {
    const result = await db.query(
      `SELECT revision, intent FROM vendo_workspace_history
       WHERE path = $1 AND owner = $2 AND intent IS NOT NULL ORDER BY revision ASC`,
      [path, owner],
    );
    return new Map(result.rows.map((row) => [text(row["intent"]), Number(row["revision"])]));
  };

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

  /** Every message write is a thread write (same token discipline as the doors)
   *  — and it is also how every message write TAKES THE THREAD ROW.
   *
   *  Call it BEFORE allocating a position, never after. `seq` has no unique
   *  constraint, so two writers landing on one number leave the transcript
   *  ordering by message id instead of by turn (THREAD_MESSAGES_AGGREGATE says
   *  so). Any `max(seq) + 1` computed while this row is unheld is computed by
   *  every concurrent writer from its own READ COMMITTED snapshot, and they all
   *  get the same answer: measured on PostgreSQL 17, a batch append racing
   *  `putMessage` collided on 20 of 20 rounds. Holding the row first makes the
   *  loser block here until the winner COMMITs, so its allocation runs on a
   *  fresh snapshot that already contains the winner's rows.
   *
   *  Every transcript writer therefore takes the SAME two locks in the SAME
   *  order — thread row, then message rows — which is also why none of them can
   *  deadlock against another. `appendThreadMessages` (helpers/rows.ts) is the
   *  batch path's copy of this rule; keep the two honest with each other. */
  const touchThread = async (q: Query, threadId: string, now: string): Promise<void> => {
    await q(
      "UPDATE vendo_threads SET updated_at = $2, revision = revision + 1 WHERE id = $1",
      [threadId, now],
    );
  };

  return {
    // -----------------------------------------------------------------------
    // engine — seven verbs onto the routed doors, with the per-collection
    // policy living there; the ONE addition is the allowlist gate, which is why
    // the audit door is still append-only and the effects door still
    // insert-once through this family.
    // -----------------------------------------------------------------------
    engine: {
      async get(collection, id) {
        assertEngineCollection(collection);
        return await recordsDoor(db, collection).get(id);
      },
      async put(collection, record) {
        assertEngineCollection(collection);
        return await db.transaction((q) => recordsDoor(txDb(q), collection).put(record));
      },
      async delete(collection, id) {
        assertEngineCollection(collection);
        await db.transaction((q) => recordsDoor(txDb(q), collection).delete(id));
      },
      async list(collection, query = {}) {
        assertEngineCollection(collection);
        const { watermark } = query;
        // No watermark, no change: the newest-first door as it always was. With
        // one, the walk goes the other way and both of its gates (indexed field,
        // no cursor alongside) live inside watermarkPage.
        if (watermark === undefined) return await recordsDoor(db, collection).list(query);
        return await watermarkPage(db, collection, { ...query, watermark });
      },
      async claim(collection, expected, replacement) {
        assertEngineCollection(collection);
        return await db.transaction(async (q) => {
          const door = recordsDoor(txDb(q), collection);
          if (door.claim === undefined) {
            throw new VendoError("not-implemented", `${collection} does not support claim`);
          }
          return await door.claim(expected, replacement);
        });
      },
      async insertIfAbsent(collection, record) {
        assertEngineCollection(collection);
        return await db.transaction(async (q) => {
          const door = recordsDoor(txDb(q), collection);
          if (door.atomic === undefined) {
            throw new VendoError("not-implemented", `${collection} does not support insertIfAbsent`);
          }
          return await door.atomic.insertIfAbsent(record);
        });
      },
      async compareAndSwap(collection, record, expectedRevision) {
        assertEngineCollection(collection);
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
    // appData — everything generated apps invent. The composer
    // (app-data-rows.ts) owns the naming, the owner stamp and the refusal of a
    // caller-supplied one; this block only decides the transaction scope.
    // -----------------------------------------------------------------------
    appData: {
      async put(target, record) {
        return await db.transaction((q) => appDataRows(txDb(q), target).put(record));
      },
      async get(target, id) {
        return await appDataRows(db, target).get(id);
      },
      async list(target, query) {
        return await appDataRows(db, target).list(query);
      },
      async delete(target, id) {
        await appDataRows(db, target).delete(id);
      },
      /** The file twins are single-statement blob verbs, exactly like the blobs
       *  family above, so none of them opens a transaction. */
      async putFile(target, key, bytes, meta) {
        await appDataFiles(store, target).put(key, bytes, meta);
      },
      async getFile(target, key) {
        return await appDataFiles(store, target).get(key);
      },
      async listFiles(target, prefix) {
        return await appDataFiles(store, target).list(prefix);
      },
      async deleteFile(target, key) {
        await appDataFiles(store, target).delete(key);
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
          // The thread row FIRST: it is what serialises this write's position
          // against every other transcript writer (see touchThread). An absent
          // thread updates nothing here and is reported below, as it always was.
          await touchThread(q, threadId, now);
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
          const record = await readThread(txDb(q), threadId);
          if (record === null) throw new VendoError("not-found", `thread ${threadId} not found`);
          return record;
        });
      },
      /** The batch append (design 4a): ownership is the caller's `subject`, so
       *  no thread download precedes the write, and the answer is the thread's
       *  new revision plus the row count — never the transcript. */
      async appendMessages(threadId, subject, messages, opts) {
        const rowIdOf = (message: unknown): string => {
          const given = (message as { id?: unknown } | null)?.id;
          return typeof given === "string" && given !== "" ? given : `msg_${globalThis.crypto.randomUUID()}`;
        };
        // Positions are assigned by appendThreadMessages' own statement, under
        // the thread row it has already taken — reading the tail out here,
        // before that lock, is what let two concurrent turns claim one seq.
        return await db.transaction((q) => appendThreadMessages(txDb(q), {
          threadId,
          subject,
          messages: messages.map((message) => ({ id: rowIdOf(message), message })),
          ...(opts?.title === undefined ? {} : { title: opts.title }),
        }));
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
          // The thread row FIRST, for the same reason putMessage does it: the
          // position this answer takes must be allocated under that lock.
          await touchThread(q, threadId, now);
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
          const record = await readThread(txDb(q), threadId);
          if (record === null) throw new VendoError("not-found", `thread ${threadId} not found`);
          return record;
        });
      },
    },

    // -----------------------------------------------------------------------
    // harness — the vendo_state slot, keyed by (appId, subject) exactly as the
    // routed `vendo_state` door keys it, through the same single write path
    // (helpers/rows putStateRow) so the two doors cannot drift.
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
        const owner = ownerFor(query);
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
      async read(paths, opts) {
        const owner = ownerFor(opts);
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
        const owner = ownerFor(opts);
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
            // A tombstone stages nothing: the removal is a row delete, and the
            // content it removes is already stored (history keeps it).
            if (entry.delete === true) continue;
            prepared.push({
              path: entry.path,
              write: await rows.prepare(owner, entry.path, encoder.encode(JSON.stringify(entry.data))),
            });
          }
          replayed = await db.transaction(async (q) => {
            const tdb = txDb(q);
            const ledger = createRecordStore(tdb, WORKSPACE_COMMITS);
            // Claim the ledger row BEFORE touching any workspace row: the
            // (collection, id) unique key is the serialization point, so of
            // two same-key racers exactly one lands — the loser conflicts on
            // the insert instead of applying a second, different mutation.
            const claimed = await ledger.atomic!.insertIfAbsent({
              id: commitId,
              data: { body, entries: parsed as unknown as Json },
              refs: { subject: owner, ...(key === undefined ? {} : { key }) },
            });
            if (claimed === null) {
              const existing = await ledger.get(commitId);
              return (existing?.data as { body?: unknown } | undefined)?.body === body;
            }
            const txRows = workspaceRows(tdb, filesFor(tdb));
            // `null` is a guard, so only the ABSENT field stays out of the map —
            // `get` then tells "must not exist yet" (null) from "unguarded"
            // (undefined), which a filter on falsiness would collapse.
            const expected = new Map<string, number | null>(
              parsed
                .filter((entry) => entry.expectedRevision !== undefined)
                .map((entry) => [entry.path, entry.expectedRevision as number | null]),
            );
            // Strict entries compare-and-swap against the revision the caller
            // read. A lost swap throws, so the transaction takes the whole
            // commit back with it: a conflicting set applies none of itself and
            // the caller re-reads once.
            //
            // `land` performs its own compare, so these heads serve the two
            // strict entries that never reach it: a TOMBSTONE, and a write whose
            // bytes already match the head. Both are still commits against a
            // revision the caller read, and skipping their compare let a stale
            // delete erase a colleague's newer content outright.
            const heads = await headRevisions(tdb, owner, [...expected.keys()]);
            const moved = (path: string): boolean => {
              const at = expected.get(path);
              return at !== undefined && heads.get(path) !== at;
            };
            const conflicts: string[] = [];
            for (const staged of prepared) {
              if (staged.write === "unchanged") {
                if (moved(staged.path)) conflicts.push(staged.path);
                continue;
              }
              const at = expected.get(staged.path);
              const written = await txRows.land(
                owner,
                staged.write,
                commitId,
                at === undefined ? undefined : { strict: true, expectedRevision: at },
              );
              if (written.conflict === true) conflicts.push(staged.path);
            }
            for (const entry of parsed) {
              if (entry.delete !== true) continue;
              if (moved(entry.path)) {
                conflicts.push(entry.path);
                continue;
              }
              await txRows.remove(owner, entry.path, commitId);
            }
            if (conflicts.length > 0) {
              throw new VendoError(
                "conflict",
                `the workspace moved on under ${conflicts.sort().join(", ")}; nothing was committed`,
                { conflicts },
              );
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
        const owner = ownerFor(query);
        const path = query?.path;
        const page = await createRecordStore(db, WORKSPACE_COMMITS).list({
          refs: { subject: owner },
          ...(query?.limit === undefined ? {} : { limit: query.limit }),
          ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        // A path narrows the page in place, so the ledger's keyset cursor keeps
        // meaning exactly what it meant: follow it for the next page, which may
        // hold more of this path's commits (or none).
        const records = path === undefined
          ? page.records
          : page.records.filter((record) => commitTouches(record, path));
        // The before-revision the entry restores to. It is not in the ledger —
        // it is the revision the write superseded, which every commit stamped
        // with its own id as the intent when it landed.
        const superseded = path === undefined
          ? new Map<string, number>()
          : await supersededRevisions(owner, path);
        return {
          entries: records.map((record) => ({
            commitId: record.id,
            entries: commitEntries(record),
            at: record.createdAt,
            ...(superseded.has(record.id) ? { revision: superseded.get(record.id) } : {}),
          })),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      },
    },

    // -----------------------------------------------------------------------
    // audit — one verb, because reading is all anyone does to an append-only
    // drawer. The filters that ARE refs (subject, app, tool) are already served
    // by engine.list("vendo_audit", { refs }); this door exists for the ones
    // that are not.
    // -----------------------------------------------------------------------
    audit: {
      async list(query = {}) {
        return await auditPage(db, query);
      },
    },

    // -----------------------------------------------------------------------
    // secrets — the vault door (secrets.ts) as-is. The one seam this layer
    // owns: the provider answers `undefined` for a name it does not hold, and
    // the op's contract is `null`.
    // -----------------------------------------------------------------------
    secrets: {
      async get(name) {
        return (await secretReader.get(name)) ?? null;
      },
      async set(name, value) {
        await secretWriter.set(name, value);
      },
      async list() {
        return await secretWriter.list();
      },
      async delete(name) {
        await secretWriter.delete(name);
      },
    },

    // -----------------------------------------------------------------------
    // retention is deliberately ABSENT (01 §12: the family is optional). This
    // engine has nowhere to quarantine rows TO, and the contract's own rule is
    // that an engine says so by omitting the family rather than by accepting
    // the call and destroying rows a quarantine was supposed to keep
    // recoverable. OSS retention is still host SQL on the host's own cron —
    // the table map is public precisely so that works (tests/retention.test.ts).
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // lifecycle
    // -----------------------------------------------------------------------
    lifecycle: {
      /** The 20-table erase saga, as-is: re-runnable, real-deletion report.
       *  Deliberately NOT one transaction — blob deletion is external work. */
      async erase(target) {
        const doors = eraseStore(store, { files });
        if (target.subject !== undefined) return await doors.bySubject(target.subject);
        if (target.appId !== undefined) return await doors.byApp(target.appId);
        invalid("lifecycle.erase needs a subject or an appId");
      },
      /** §9.5 — the app row flip and the workspace document move, which the
       *  umbrella ran as a two-step seam, are ONE transaction here, and so is
       *  everything else the app owns: its appData and its bearer token. */
      async promote(appId, orgId) {
        await db.transaction(async (q) => {
          const tdb = txDb(q);
          const current = await q("SELECT subject FROM vendo_apps WHERE id = $1", [appId]);
          const from = current.rows[0]?.["subject"];
          if (typeof from !== "string") {
            throw new VendoError("not-found", `App ${appId} was not found`);
          }
          if (from === orgId) return; // already the org's — idempotent
          // Legacy appData carries no owner stamp, and this runs BEFORE the row
          // flip on purpose: the stamp it writes is `vendo_apps.subject`, still
          // `from` at this point, so the reown below is ONE uniform
          // `from` → `orgId` rename with no legacy-vs-stamped ambiguity left in
          // the table. Do not "simplify" it to after the flip: the stamp would
          // then write `orgId` while the rename still looks for `from`, and the
          // two halves would disagree about which rows are legacy.
          await backfillAppDataOnDb(tdb, { appId });
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
          // The app's data changes hands with the app: appData is auto-scoped
          // to the owner, and the owner IS `vendo_apps.subject`, so without
          // this the org goes blind to its own app's rows and files. A blob
          // primary-key collision here throws and rolls the whole promote back
          // — §9.5 is all-or-nothing, and there is no resolution to invent.
          await reownAppData(tdb, appId, from, orgId);
          // And so does the app's bearer. The box keeps calling back with the
          // token it already holds; left on the departed personal subject it
          // would keep writing rows stamped with a subject that no longer owns
          // the app (`refs.subject` is exactly what apps' `verify` returns).
          await q(
            `UPDATE vendo_records SET refs = refs || $2::jsonb
             WHERE collection = $1 AND refs @> $3::jsonb`,
            [APP_TOKENS, jsonParam({ subject: orgId }), jsonParam({ app_id: appId })],
          );
        });
      },
    },

    async footprint() {
      return await collectionFootprints(db);
    },

    async status() {
      // 42 of STORE_WIRE_PATHS' 44: `ops` is a LEVEL over that list's declared
      // order, and the two this engine does not serve — retention.quarantine and
      // retention.purge — are declared last for exactly this reason, so the
      // level stops honestly at footprint instead of claiming a family that is
      // absent from the object above.
      return { format: VENDO_STORE_WIRE_FORMAT, ops: 42 };
    },
  };
}
