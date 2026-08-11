import { assertEngineCollection } from "../engine-collections.js";
import { VendoError } from "../errors.js";
import type { IsoDateTime } from "../ids.js";
import { VENDO_STORE_WIRE_FORMAT, type StoreWireStatus } from "../store-wire.js";
import {
  APP_DATA_COLLECTION_PATTERN,
  APP_DATA_OWNER_PATTERN,
  type AppDataTarget,
  type RecordInput,
  type RecordQuery,
  type StoreOps,
  type VendoRecord,
} from "../store.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let monotonicMs = 0;
const isoNow = (): IsoDateTime => {
  monotonicMs = Math.max(Date.now(), monotonicMs + 1);
  return new Date(monotonicMs).toISOString() as IsoDateTime;
};

/** The synthetic harness appId a thread's state rides under (the store's
    `harnessStateKey`), so deleting the thread can sweep it. */
const harnessSlot = (threadId: string): string => `harness_state:${threadId}`;

/** Store wire v1: every list op pages at 100 by default and caps at 1000. */
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const pageLimit = (limit?: number): number => (limit === undefined ? DEFAULT_PAGE : Math.min(limit, MAX_PAGE));

const copyRecord = (r: VendoRecord): VendoRecord => ({
  id: r.id,
  data: jsonCopy(r.data),
  ...(r.refs ? { refs: { ...r.refs } } : {}),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  ...(r.revision ? { revision: r.revision } : {}),
});

// ---------------------------------------------------------------------------
// memory StoreOps — just enough to pass the conformance suite
// ---------------------------------------------------------------------------

export function memoryStoreOps(): StoreOps {
  // records: Map<collection, Map<id, record>>
  const collections = new Map<string, Map<string, VendoRecord & { seq: number }>>();
  let sequence = 0;

  const col = (c: string) => {
    let m = collections.get(c);
    if (!m) { m = new Map(); collections.set(c, m); }
    return m;
  };

  // blobs: Map<namespace, Map<key, blob>>
  const blobStore = new Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>();
  const ns = (n: string) => {
    let m = blobStore.get(n);
    if (!m) { m = new Map(); blobStore.set(n, m); }
    return m;
  };

  // transcripts: Map<threadId, thread>
  type Thread = { id: string; subject: string; messages: unknown[]; title?: string; answers: Set<string> };
  const threads = new Map<string, { record: VendoRecord & { seq: number }; thread: Thread }>();

  // harness: Map<"appId:subject", state>
  const harnessState = new Map<string, unknown>();

  // workspace — one drawer per owner (the end user or org the files belong to);
  // a call with no owner rides the bound single-player default, exactly as the
  // local backend does.
  type WsEntry = { path: string; data?: unknown; delete?: true; expectedRevision?: number | null };
  type WsFile = { data: unknown; revision: number; updatedAt: IsoDateTime };
  /** `beforeRevision` is which revision each path held before the commit —
      absent when the commit created it, which is how the path-scoped history
      tells an overwrite from a create. */
  type WsCommit = {
    id: string;
    owner: string;
    at: IsoDateTime;
    entries: WsEntry[];
    beforeRevision: Map<string, number>;
  };
  const BOUND_OWNER = "user_local";
  const drawers = new Map<string, Map<string, WsFile>>();
  const drawer = (owner: string): Map<string, WsFile> => {
    let files = drawers.get(owner);
    if (!files) { files = new Map(); drawers.set(owner, files); }
    return files;
  };
  const wsCommits: WsCommit[] = [];
  let wsCommitSeq = 0;
  // idempotency key -> the body it first carried, so a replay can be told from
  // a reuse of the key for different entries.
  const wsIdempotencyKeys = new Map<string, string>();

  // ---------------------------------------------------------------------------
  // rows — the shared generic-collection implementation the engine and appData
  // families are both built on. NOT an op family of its own: the wire's generic
  // records family is gone, so nothing outside this module reaches these verbs.
  // ---------------------------------------------------------------------------

  const putRecord = (collection: string, input: RecordInput): VendoRecord => {
    const m = col(collection);
    const prev = m.get(input.id);
    const now = isoNow();
    sequence += 1;
    const record: VendoRecord & { seq: number } = {
      id: input.id,
      data: jsonCopy(input.data),
      refs: input.refs ? { ...input.refs } : undefined,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      revision: String(BigInt(prev?.revision ?? "0") + 1n),
      seq: prev?.seq ?? sequence,
    };
    m.set(record.id, record);
    return copyRecord(record);
  };

  const rows: StoreOps["engine"] = {
    async get(collection, id) {
      const r = col(collection).get(id);
      return r ? copyRecord(r) : null;
    },
    async put(collection, record) {
      return putRecord(collection, record);
    },
    async delete(collection, id) {
      col(collection).delete(id);
    },
    async list(collection, query: RecordQuery = {}) {
      const m = col(collection);
      const filtered = [...m.values()].filter((r) => {
        if (query.ids && !query.ids.includes(r.id)) return false;
        if (query.refs) {
          for (const [k, v] of Object.entries(query.refs)) {
            if (r.refs?.[k] !== v) return false;
          }
        }
        return true;
      }).sort((a, b) =>
        a.createdAt === b.createdAt ? b.seq - a.seq : (a.createdAt < b.createdAt ? 1 : -1),
      );
      const offset = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10)) : 0;
      const end = Math.min(offset + pageLimit(query.limit), filtered.length);
      return {
        records: filtered.slice(offset, end).map(copyRecord),
        ...(end < filtered.length ? { cursor: String(end) } : {}),
      };
    },
    async claim(collection, expected, replacement) {
      const m = col(collection);
      const current = m.get(expected.id);
      if (!current) return false;
      const dataMatch = JSON.stringify(current.data) === JSON.stringify(expected.data);
      const refsMatch = JSON.stringify(current.refs ?? {}) === JSON.stringify(expected.refs ?? {});
      if (!dataMatch || !refsMatch) return false;
      if (replacement) {
        putRecord(collection, { id: expected.id, data: replacement.data, refs: replacement.refs as Record<string, string> | undefined });
      } else {
        m.delete(expected.id);
      }
      return true;
    },
    async insertIfAbsent(collection, record) {
      if (col(collection).has(record.id)) return null;
      return putRecord(collection, record);
    },
    async compareAndSwap(collection, record, expectedRevision) {
      const prev = col(collection).get(record.id);
      if (!prev || prev.revision !== expectedRevision) return null;
      return putRecord(collection, record);
    },
  };

  // ---------------------------------------------------------------------------
  // engine family — the generic rows above, behind the allowlist gate
  // ---------------------------------------------------------------------------

  /** MIRRORS the per-collection policy the real backend enforces in its typed
      doors (packages/store/src/routing.ts), which the generic records table has
      no idea about. Only the policy the conformance suite pins lives here — the
      reference exists to prove the contract, not to re-implement routing. */
  const APPEND_ONLY = new Set(["vendo_audit", "vendo_effects"]);
  const INSERT_ONCE = new Set(["vendo_effects"]);

  const engine: StoreOps["engine"] = {
    async get(collection, id) {
      assertEngineCollection(collection);
      return rows.get(collection, id);
    },
    async put(collection, record) {
      assertEngineCollection(collection);
      if (INSERT_ONCE.has(collection)) {
        // A receipt that already exists is the truth about what executed, so a
        // second put hands back the RECORDED row rather than overwriting it.
        const held = await rows.get(collection, record.id);
        if (held) return held;
      }
      return rows.put(collection, record);
    },
    async delete(collection, id) {
      assertEngineCollection(collection);
      if (APPEND_ONLY.has(collection)) {
        throw new VendoError(
          "blocked",
          `${collection} is append-only; rows are erased only via the store erase API (02-store §5)`,
        );
      }
      await rows.delete(collection, id);
    },
    async list(collection, query) {
      assertEngineCollection(collection);
      return rows.list(collection, query);
    },
    async claim(collection, expected, replacement) {
      assertEngineCollection(collection);
      return rows.claim(collection, expected, replacement);
    },
    async insertIfAbsent(collection, record) {
      assertEngineCollection(collection);
      return rows.insertIfAbsent(collection, record);
    },
    async compareAndSwap(collection, record, expectedRevision) {
      assertEngineCollection(collection);
      return rows.compareAndSwap(collection, record, expectedRevision);
    },
  };

  // ---------------------------------------------------------------------------
  // blobs family
  // ---------------------------------------------------------------------------

  const blobs: StoreOps["blobs"] = {
    async put(namespace, key, bytes, meta) {
      ns(namespace).set(key, {
        bytes: new Uint8Array(bytes),
        ...(meta?.contentType ? { contentType: meta.contentType } : {}),
      });
    },
    async get(namespace, key) {
      const b = ns(namespace).get(key);
      if (!b) return null;
      return { bytes: new Uint8Array(b.bytes), ...(b.contentType ? { contentType: b.contentType } : {}) };
    },
    async delete(namespace, key) {
      ns(namespace).delete(key);
    },
    async list(namespace, prefix = "") {
      return [...ns(namespace).keys()].filter((k) => k.startsWith(prefix));
    },
  };

  // ---------------------------------------------------------------------------
  // appData family
  // ---------------------------------------------------------------------------

  /** The owner leg is fenced for the reason `ownedKey` shows: it is the first
      path segment of every file key, so owner "a/b" and owner "a" writing
      "b/…" would be one and the same key. */
  const appOwner = (target: AppDataTarget): string => {
    if (!APP_DATA_OWNER_PATTERN.test(target.owner)) {
      throw new VendoError("validation", `app data owner "${target.owner}" must be non-empty and free of "/"`);
    }
    return target.owner;
  };

  /** The reference's own copy of the naming grammar — rows land in one
      collection per app+collection, files in the blob namespace of the same
      name. The real backend composes both in one place, which core cannot
      import. Every verb goes through here, so the owner fence rides along. */
  const appCollection = (target: AppDataTarget): string => {
    if (target.appId === "" || target.appId.includes(":")) {
      throw new VendoError("validation", `app data appId "${target.appId}" must be non-empty and free of ":"`);
    }
    if (!APP_DATA_COLLECTION_PATTERN.test(target.collection)) {
      throw new VendoError("validation", `app data collection "${target.collection}" is not a legal name`);
    }
    appOwner(target);
    return `app:${target.appId}:${target.collection}`;
  };

  /** Files are scoped by key prefix rather than by a stamp, so the owner leg
      never reaches the caller — `listFiles` strips it back off. */
  const ownedKey = (target: AppDataTarget, key: string): string => `${appOwner(target)}/${key}`;

  const refuseSubject = (refs: Record<string, string> | undefined, verb: string): void => {
    if (refs !== undefined && "subject" in refs) {
      throw new VendoError("validation", `appData.${verb} may not supply refs.subject; the owner is stamped from the session`);
    }
  };

  const appData: StoreOps["appData"] = {
    async put(target, record) {
      const collection = appCollection(target);
      refuseSubject(record.refs, "put");
      const held = col(collection).get(record.id);
      if (held !== undefined && held.refs?.["subject"] !== target.owner) {
        throw new VendoError("conflict", `app data id "${record.id}" is already held in this collection`);
      }
      return rows.put(collection, { ...record, refs: { ...record.refs, subject: target.owner } });
    },
    async get(target, id) {
      const record = await rows.get(appCollection(target), id);
      return record?.refs?.["subject"] === target.owner ? record : null;
    },
    async list(target, query = {}) {
      const collection = appCollection(target);
      refuseSubject(query.refs, "list");
      return rows.list(collection, { ...query, refs: { ...query.refs, subject: target.owner } });
    },
    async delete(target, id) {
      const collection = appCollection(target);
      if (col(collection).get(id)?.refs?.["subject"] !== target.owner) return;
      await rows.delete(collection, id);
    },
    async putFile(target, key, bytes, meta) {
      await blobs.put(appCollection(target), ownedKey(target, key), bytes, meta);
    },
    async getFile(target, key) {
      return blobs.get(appCollection(target), ownedKey(target, key));
    },
    async listFiles(target, prefix = "") {
      const keys = await blobs.list(appCollection(target), ownedKey(target, prefix));
      return keys.map((key) => key.slice(target.owner.length + 1));
    },
    async deleteFile(target, key) {
      await blobs.delete(appCollection(target), ownedKey(target, key));
    },
  };

  // ---------------------------------------------------------------------------
  // transcripts family
  // ---------------------------------------------------------------------------

  const threadRecord = (id: string, t: Thread, prev?: VendoRecord): VendoRecord & { seq: number } => {
    const now = isoNow();
    sequence += 1;
    return {
      id,
      data: { subject: t.subject, messages: jsonCopy(t.messages), ...(t.title ? { title: t.title } : {}) },
      refs: { subject: t.subject },
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      revision: String(BigInt(prev?.revision ?? "0") + 1n),
      seq: sequence,
    };
  };

  const transcripts: StoreOps["transcripts"] = {
    async putThread(thread) {
      const existing = threads.get(thread.id);
      const t: Thread = {
        id: thread.id,
        subject: thread.subject,
        messages: jsonCopy(thread.messages),
        title: thread.title,
        answers: existing?.thread.answers ?? new Set(),
      };
      const rec = threadRecord(thread.id, t, existing?.record);
      threads.set(thread.id, { record: rec, thread: t });
      return copyRecord(rec);
    },
    async getThread(id, _opts) {
      const entry = threads.get(id);
      return entry ? copyRecord(entry.record) : null;
    },
    async listThreads(query) {
      let all = [...threads.values()];
      if (query?.subject) {
        all = all.filter((e) => e.thread.subject === query.subject);
      }
      all.sort((a, b) =>
        a.record.createdAt === b.record.createdAt
          ? b.record.seq - a.record.seq
          : (a.record.createdAt < b.record.createdAt ? 1 : -1),
      );
      const offset = query?.cursor ? Math.max(0, Number.parseInt(query.cursor, 10)) : 0;
      const end = Math.min(offset + pageLimit(query?.limit), all.length);
      return {
        records: all.slice(offset, end).map((e) => copyRecord(e.record)),
        ...(end < all.length ? { cursor: String(end) } : {}),
      };
    },
    async deleteThread(id) {
      threads.delete(id);
      // The cascade: a thread's harness state rides the `harness_state:<id>`
      // slot, so it dies with the thread rather than outliving it.
      for (const k of harnessState.keys()) {
        if (k.startsWith(`${harnessSlot(id)}:`)) harnessState.delete(k);
      }
    },
    /** Insert, or EDIT BY ID: a message whose id is already in the thread
        replaces it in place — that is how an approval flips from pending to
        answered. Appending it would leave two messages under one id, which
        every real backend refuses. */
    async putMessage(threadId, message) {
      const entry = threads.get(threadId);
      if (!entry) throw new VendoError("not-found", `thread ${threadId} not found`);
      const id = (message as { id?: unknown } | null)?.id;
      const at = typeof id === "string" && id !== ""
        ? entry.thread.messages.findIndex((m) => (m as { id?: unknown } | null)?.id === id)
        : -1;
      if (at !== -1) entry.thread.messages[at] = jsonCopy(message);
      else entry.thread.messages.push(jsonCopy(message));
      const rec = threadRecord(threadId, entry.thread, entry.record);
      threads.set(threadId, { record: rec, thread: entry.thread });
      return copyRecord(rec);
    },
    async recordAnswer(threadId, answer) {
      const entry = threads.get(threadId);
      if (!entry) throw new VendoError("not-found", `thread ${threadId} not found`);
      // Derive an id from the answer for dedup
      const answerId = typeof answer === "object" && answer !== null && "id" in answer
        ? String((answer as { id: unknown }).id)
        : JSON.stringify(answer);
      const key = `${threadId}:${answerId}`;
      if (entry.thread.answers.has(key)) {
        throw new VendoError("conflict", `duplicate answer in thread ${threadId}`);
      }
      entry.thread.answers.add(key);
      entry.thread.messages.push(jsonCopy(answer));
      const rec = threadRecord(threadId, entry.thread, entry.record);
      threads.set(threadId, { record: rec, thread: entry.thread });
      return copyRecord(rec);
    },
  };

  // ---------------------------------------------------------------------------
  // harness family
  // ---------------------------------------------------------------------------

  const harness: StoreOps["harness"] = {
    async get(appId, subject) {
      const v = harnessState.get(`${appId}:${subject}`);
      return v === undefined ? null : jsonCopy(v);
    },
    async set(appId, subject, state) {
      harnessState.set(`${appId}:${subject}`, jsonCopy(state));
    },
    async clear(appId, subject) {
      harnessState.delete(`${appId}:${subject}`);
    },
  };

  // ---------------------------------------------------------------------------
  // workspace family
  // ---------------------------------------------------------------------------

  const byteLength = (data: unknown): number =>
    new TextEncoder().encode(JSON.stringify(data ?? null)).length;

  const workspace: StoreOps["workspace"] = {
    async index(query) {
      const files = drawer(query?.owner ?? BOUND_OWNER);
      const entries = [...files.entries()].map(([path, file]) => ({
        path,
        bytes: byteLength(file.data),
        revision: file.revision,
        updatedAt: file.updatedAt,
      }));
      const offset = query?.cursor ? Math.max(0, Number.parseInt(query.cursor, 10)) : 0;
      const end = Math.min(offset + pageLimit(query?.limit), entries.length);
      return {
        entries: entries.slice(offset, end),
        ...(end < entries.length ? { cursor: String(end) } : {}),
      };
    },
    async read(paths, opts) {
      const files = drawer(opts?.owner ?? BOUND_OWNER);
      const result: Record<string, unknown> = {};
      for (const p of paths) {
        const file = files.get(p);
        if (file !== undefined) result[p] = jsonCopy(file.data);
      }
      return result;
    },
    async commit(entries, opts) {
      const owner = opts?.owner ?? BOUND_OWNER;
      // One commit, one mutation per path: two entries for the same path leave
      // the commit with no single before-image, so the path's trail could not
      // say which revision this commit replaced.
      const paths = new Set<string>();
      for (const entry of entries as WsEntry[]) {
        if (paths.has(entry.path)) {
          throw new VendoError("validation", `workspace entry ${entry.path} appears twice in one commit`);
        }
        paths.add(entry.path);
      }
      const key = opts?.idempotencyKey;
      if (key !== undefined) {
        const body = JSON.stringify(entries);
        const recorded = wsIdempotencyKeys.get(key);
        if (recorded === body) return; // a replay: hand back the recorded result
        if (recorded !== undefined) {
          throw new VendoError("conflict", `idempotency key ${key} was already used for different entries`);
        }
        wsIdempotencyKeys.set(key, body);
      }
      const files = drawer(owner);
      // Strict compare-and-swap is checked for the WHOLE set first: a commit
      // that conflicts on one path applies none of itself.
      // `null` is the create-only guard, so an ABSENT path reads as `null` and
      // matches it; only the missing field is unguarded.
      const conflicts = (entries as WsEntry[])
        .filter((e) => e.expectedRevision !== undefined
          && (files.get(e.path)?.revision ?? null) !== e.expectedRevision)
        .map((e) => e.path);
      if (conflicts.length > 0) {
        throw new VendoError(
          "conflict",
          `the workspace moved on under ${conflicts.sort().join(", ")}; nothing was committed`,
        );
      }
      wsCommitSeq += 1;
      const beforeRevision = new Map<string, number>();
      for (const e of entries as WsEntry[]) {
        const current = files.get(e.path);
        if (current !== undefined) beforeRevision.set(e.path, current.revision);
        if (e.delete === true) {
          files.delete(e.path);
          continue;
        }
        files.set(e.path, {
          data: jsonCopy(e.data),
          revision: (current?.revision ?? 0) + 1,
          updatedAt: isoNow(),
        });
      }
      wsCommits.push({
        id: String(wsCommitSeq),
        owner,
        at: isoNow(),
        entries: entries as WsEntry[],
        beforeRevision,
      });
    },
    async history(query) {
      const owner = query?.owner ?? BOUND_OWNER;
      const path = query?.path;
      const all = wsCommits
        .filter((c) => c.owner === owner
          && (path === undefined || c.entries.some((e) => e.path === path)))
        .map((c) => ({
          commitId: c.id,
          entries: c.entries,
          at: c.at,
          ...(path !== undefined && c.beforeRevision.has(path)
            ? { revision: c.beforeRevision.get(path)! }
            : {}),
        }));
      all.reverse(); // newest first
      const offset = query?.cursor ? Math.max(0, Number.parseInt(query.cursor, 10)) : 0;
      const end = Math.min(offset + pageLimit(query?.limit), all.length);
      return {
        entries: all.slice(offset, end),
        ...(end < all.length ? { cursor: String(end) } : {}),
      };
    },
  };

  // ---------------------------------------------------------------------------
  // lifecycle family
  // ---------------------------------------------------------------------------

  const lifecycle: StoreOps["lifecycle"] = {
    async erase(target) {
      // Clear records matching subject/appId
      if (target.subject) {
        for (const [, m] of collections) {
          for (const [id, r] of m) {
            if (r.refs?.["subject"] === target.subject) m.delete(id);
          }
        }
        // Clear threads for subject
        for (const [id, entry] of threads) {
          if (entry.thread.subject === target.subject) threads.delete(id);
        }
        // Clear harness
        for (const k of harnessState.keys()) {
          if (k.endsWith(`:${target.subject}`)) harnessState.delete(k);
        }
      }
      if (target.appId) {
        for (const k of harnessState.keys()) {
          if (k.startsWith(`${target.appId}:`)) harnessState.delete(k);
        }
      }
      return { erased: true };
    },
    async promote(appId, orgId) {
      // §9.5: the org becomes the app row's owning subject.
      const app = col("vendo_apps").get(appId);
      if (!app) throw new VendoError("not-found", `app ${appId} not found`);
      app.refs = { ...app.refs, subject: orgId };
    },
  };

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  return {
    engine,
    blobs,
    appData,
    transcripts,
    harness,
    workspace,
    lifecycle,
    async status(): Promise<StoreWireStatus> {
      return { format: VENDO_STORE_WIRE_FORMAT, ops: 35 };
    },
  };
}
