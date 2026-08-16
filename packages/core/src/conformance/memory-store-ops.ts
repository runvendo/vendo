import type { AuditEvent } from "../audit.js";
import { assertEngineCollection, assertIndexedField, collectionKind, engineAppHistory } from "../engine-collections.js";
import { VendoError } from "../errors.js";
import type { IsoDateTime } from "../ids.js";
import { STORE_WIRE_PATHS, VENDO_STORE_WIRE_FORMAT, type StoreWireStatus } from "../store-wire.js";
import {
  APP_DATA_COLLECTION_PATTERN,
  APP_DATA_OWNER_PATTERN,
  type AppDataTarget,
  type AuditFilters,
  type AuditTallyRow,
  type CollectionFootprint,
  type RecordInput,
  type RecordQuery,
  type StoreOps,
  type UsageEvent,
  type UsageTallyRow,
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

/** The forward walk's echoed bound: a resume token naming the last row a page
    ended on, its indexed VALUE and its ID together. The value alone cannot say
    where inside a group of rows sharing it the page stopped, and those groups
    are routine — `vendo_runs.started_at` is caller-supplied at millisecond
    precision. Prefixed because a caller's first bound is a plain field value,
    and anything that does not decode as a token is read as one. The encoding is
    this reference's own: the token is opaque contract and only ever travels
    back to the implementation that minted it. */
const WATERMARK_TOKEN = "wm1_";

const encodeWatermark = (value: string, id: string): string =>
  `${WATERMARK_TOKEN}${JSON.stringify([value, id])}`;

const decodeWatermark = (after: string): { value: string; id: string } | undefined => {
  if (!after.startsWith(WATERMARK_TOKEN)) return undefined;
  try {
    const parsed = JSON.parse(after.slice(WATERMARK_TOKEN.length)) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return undefined;
    return { value: parsed[0], id: parsed[1] };
  } catch {
    return undefined;
  }
};

/** The synthetic harness appId a thread's state rides under (the store's
    `harnessStateKey`), so deleting the thread can sweep it. */
const harnessSlot = (threadId: string): string => `harness_state:${threadId}`;

/** The UTC hour an event falls in, as the instant that hour starts — the tally's
    bucket key. */
const hourBucket = (at: IsoDateTime): IsoDateTime => {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString() as IsoDateTime;
};

/** Ascending, with an ABSENT dimension last: `null` is a group of its own (a
    control event is not a call and carries no outcome), and where it sorts has
    to be contract or two implementations answer the same window in two orders. */
const byDimension = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : (a < b ? -1 : 1);

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
      if (query?.watermark === undefined) return await rows.list(collection, query);
      const { field, after } = query.watermark;
      assertIndexedField(collection, field);
      if (query.cursor !== undefined) {
        throw new VendoError(
          "validation",
          "engine.list takes a watermark or a cursor, never both — they page in opposite directions",
        );
      }
      // The bound is on the row's own INDEXED FIELD, which for the one
      // collection that declares one is CALLER-SUPPLIED: a host writes
      // `startedAt: new Date().toISOString()`, so a burst of runs shares one
      // millisecond. This reference stamps its own arrival clock on `createdAt`
      // and that clock is monotonic, so walking it could never tie — and the
      // tie is the case the walk has to survive. Read what the caller wrote.
      const valueOf = (r: VendoRecord): string => {
        const supplied = (r.data as { startedAt?: unknown }).startedAt;
        return collection === "vendo_runs" && typeof supplied === "string" ? supplied : r.createdAt;
      };
      // A bare bound keeps its strictly-after-the-instant meaning; a token
      // resumes exactly after the row it names, on the same (value, id) key the
      // page is ordered by. Ascending, because a forward walk resumes where it
      // stopped, and tie-broken on the id the token carries — an order that
      // disagreed with the bound would skip rows at every page boundary.
      const resume = decodeWatermark(after);
      const forward = [...col(collection).values()]
        .filter((r) => (resume === undefined
          ? valueOf(r) > after
          : valueOf(r) > resume.value || (valueOf(r) === resume.value && r.id > resume.id)))
        .sort((a, b) => (valueOf(a) === valueOf(b)
          ? (a.id < b.id ? -1 : 1)
          : (valueOf(a) < valueOf(b) ? -1 : 1)));
      const page = forward.slice(0, pageLimit(query.limit));
      const last = page.at(-1);
      return {
        records: page.map(copyRecord),
        // The bound to send next time: the row this page ended on, or the
        // caller's own bound back unchanged when nothing was there to move it.
        watermark: last === undefined ? after : encodeWatermark(valueOf(last), last.id),
      };
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
    async getThread(id) {
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
    /** The batch append, and the three things that make it more than a loop
        over putMessage: the SUBJECT is named by the caller (so ownership is
        decided without downloading the thread), an id the thread already holds
        is an EDIT that keeps its decided position (moving it would reorder the
        conversation the next turn reads), and a thread that does not exist yet
        is CREATED under the named subject — the local backend's upsert, which
        is what lets a harness land turn one without a separate putThread. */
    async appendMessages(threadId, subject, messages, opts) {
      if (messages.length === 0) {
        throw new VendoError(
          "validation",
          `transcripts.appendMessages needs at least one message; the batch for thread ${threadId} was empty`,
        );
      }
      // Two messages under one id cannot BOTH land, and a backend that upserts
      // them in one statement loses the whole write to a duplicate-key error —
      // so the offender is named here instead.
      const idOf = (message: unknown): string => {
        const given = (message as { id?: unknown } | null)?.id;
        return typeof given === "string" && given !== "" ? given : `msg_${String(sequence += 1)}`;
      };
      const ids = messages.map(idOf);
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          throw new VendoError(
            "validation",
            `thread ${threadId} carries two messages with the id ${JSON.stringify(id)}; message ids must be unique within a thread`,
          );
        }
        seen.add(id);
      }
      const existing = threads.get(threadId);
      if (existing !== undefined && existing.thread.subject !== subject) {
        throw new VendoError("conflict", `thread ${threadId} belongs to another subject`);
      }
      const thread: Thread = existing?.thread ?? {
        id: threadId,
        subject,
        messages: [],
        answers: new Set(),
      };
      if (opts?.title !== undefined) thread.title = opts.title;
      for (const [index, id] of ids.entries()) {
        // The message is stored VERBATIM, exactly as putMessage stores it: the
        // row id a backend invents for an id-less message is the row's, not the
        // message's, so injecting it here would invent a field no other
        // implementation has.
        const at = thread.messages.findIndex((held) => (held as { id?: unknown } | null)?.id === id);
        if (at === -1) thread.messages.push(jsonCopy(messages[index]));
        else thread.messages[at] = jsonCopy(messages[index]);
      }
      const record = threadRecord(threadId, thread, existing?.record);
      threads.set(threadId, { record, thread });
      return { revision: record.revision!, count: messages.length };
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
      // An empty commit has no single right answer — a commit id and a trail
      // entry for a change nobody made, or silence — and the wire has always
      // refused it, so it is refused here too.
      if (entries.length === 0) {
        throw new VendoError("validation", "a workspace commit must carry at least one entry");
      }
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
        // The OWNER is part of the ledger key, exactly as `IdempotencyScope`'s
        // `tenant` is (store.ts): clients pick their own keys and two owners
        // will pick the same one, and a ledger keyed on the key alone answers
        // the second owner's commit out of the first owner's record.
        const scope = JSON.stringify([owner, key]);
        const recorded = wsIdempotencyKeys.get(scope);
        if (recorded === body) return; // a replay: hand back the recorded result
        if (recorded !== undefined) {
          throw new VendoError("conflict", `idempotency key ${key} was already used for different entries`);
        }
        wsIdempotencyKeys.set(scope, body);
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
        // The paths ride the DETAIL as well as the message: a caller that has
        // to re-read and retry needs the list, and parsing it back out of a
        // sentence is not a contract anyone can hold.
        throw new VendoError(
          "conflict",
          `the workspace moved on under ${conflicts.sort().join(", ")}; nothing was committed`,
          { conflicts: conflicts.sort() },
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
        // A quarantined row is STILL this person's data. Sweeping it here is
        // what stops a retention lift from becoming a way to outlive an
        // erasure — the same hole the local backend closes by matching the
        // subject it copies onto every lifted row (store/src/erase.ts).
        for (const [collection, held] of quarantined) {
          quarantined.set(collection, held.filter((row) => row.record.refs?.["subject"] !== target.subject));
        }
      }
      if (target.appId) {
        // Everything the app owns, and nothing beside it: its own drawers
        // (`app:<id>:<collection>`, rows and files alike), its version history,
        // its harness state, and the app record itself. NOT the user's threads
        // — uninstalling an app is not erasing the person who installed it.
        const prefix = `app:${target.appId}:`;
        for (const name of [...collections.keys()]) {
          if (name.startsWith(prefix) || name === engineAppHistory(target.appId)) collections.delete(name);
        }
        for (const name of [...blobStore.keys()]) {
          if (name.startsWith(prefix)) blobStore.delete(name);
        }
        for (const k of harnessState.keys()) {
          if (k.startsWith(`${target.appId}:`)) harnessState.delete(k);
        }
        // The app's lifted rows too, by the same rule as the subject leg — and
        // on both selectors the live rows needed: the app's own drawers, and
        // its version log, whose rows name their app only in the collection.
        for (const [collection] of quarantined) {
          if (collection.startsWith(prefix) || collection === engineAppHistory(target.appId)) {
            quarantined.delete(collection);
          }
        }
        col("vendo_apps").delete(target.appId);
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
  // audit — the typed reads over the append-only drawer: the feed, and the
  // same rows counted
  // ---------------------------------------------------------------------------

  /** The four filters, ANDed — one copy, read by both doors, because a tally
      that narrows differently from the feed counts rows the feed never shows. */
  const matchesFilters = (event: AuditEvent, filters: AuditFilters): boolean =>
    (filters.kind === undefined || event.kind === filters.kind)
    && (filters.venue === undefined || event.venue === filters.venue)
    && (filters.outcome === undefined || event.outcome === filters.outcome)
    && (filters.decidedBy === undefined || event.decidedBy === filters.decidedBy);

  const audit: StoreOps["audit"] = {
    async list(query = {}) {
      const page = await rows.list("vendo_audit", {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      // Filtering AFTER the page is a reference's licence, not the contract:
      // a real backend narrows in its own statement. What the suite pins is
      // WHICH rows come back, in what order, and that the cursor walks them
      // all — none of which this shortcut changes.
      const events = page.records
        .map((record) => record.data as AuditEvent)
        .filter((event) => matchesFilters(event, query));
      return { events, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
    },
    // Counting, where the real backend groups in SQL. Over the WHOLE drawer and
    // not through `list`: a page is capped at 1000 rows and a tally answers a
    // window, so a reference that counted a page would quietly answer a
    // different question as soon as the window outgrew one.
    async tally(query) {
      const from = Date.parse(query.from);
      const groups = new Map<string, AuditTallyRow>();
      for (const record of col("vendo_audit").values()) {
        const event = record.data as AuditEvent;
        // The floor is INCLUSIVE.
        if (Date.parse(event.at) < from || !matchesFilters(event, query)) continue;
        const row = {
          bucket: hourBucket(event.at),
          outcome: event.outcome ?? null,
          decidedBy: event.decidedBy ?? null,
          count: 1,
        };
        const key = `${row.bucket}|${row.outcome}|${row.decidedBy}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, row);
        else group.count += 1;
      }
      return [...groups.values()].sort((a, b) =>
        (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0)
        || byDimension(a.outcome, b.outcome)
        || byDimension(a.decidedBy, b.decidedBy));
    },
  };

  // ---------------------------------------------------------------------------
  // secrets — plaintext here BY DESIGN: a reference has nothing to protect and
  // no key to hold, and a fake cipher would prove nothing the real one does.
  // ---------------------------------------------------------------------------

  const vault = new Map<string, string>();
  const secrets: StoreOps["secrets"] = {
    async get(name) {
      return vault.get(name) ?? null;
    },
    async set(name, value) {
      vault.set(name, value);
    },
    async list() {
      // Sorted, because "the order the Map happened to be written in" is not an
      // answer any two implementations would agree on.
      return [...vault.keys()].sort();
    },
    async delete(name) {
      vault.delete(name);
    },
  };

  // ---------------------------------------------------------------------------
  // retention — the engine's OWN quarantine, which is why it is a map in here
  // and not a collection: no caller may name it, and `purge` is the only way
  // back out. A lifted row keeps the arrival clock's reading of WHEN it was
  // lifted, because the grace a purge honors runs from the lift and not from
  // the row's own age, which is already past.
  // ---------------------------------------------------------------------------

  const quarantined = new Map<string, Array<{ record: VendoRecord & { seq: number }; at: number }>>();

  const retention: StoreOps["retention"] = {
    async quarantine(collection, olderThan) {
      assertEngineCollection(collection);
      const held = quarantined.get(collection) ?? [];
      const rows = col(collection);
      const cutoff = Date.parse(olderThan);
      const at = Date.parse(isoNow());
      let moved = 0;
      for (const record of [...rows.values()]) {
        if (Date.parse(record.createdAt) >= cutoff) continue;
        rows.delete(record.id);
        held.push({ record, at });
        moved += 1;
      }
      quarantined.set(collection, held);
      // The count is what LEFT the live collection — never the window's whole
      // population, which is the mistake a cron makes exactly once, on its
      // second run.
      return { moved };
    },
    async purge(collection, quarantinedBefore) {
      assertEngineCollection(collection);
      const held = quarantined.get(collection) ?? [];
      const kept = held.filter((row) => row.at >= Date.parse(quarantinedBefore));
      quarantined.set(collection, kept);
      return { purged: held.length - kept.length };
    },
  };

  // ---------------------------------------------------------------------------
  // usage — a LIST of events and not a per-window counter, for the reason the
  // real table is one: a policy authors its own window, down to the minute, and
  // a pre-bucketed count can only answer the periods whoever bucketed it picked.
  // ---------------------------------------------------------------------------

  const metered: UsageEvent[] = [];
  const inWindow = (event: UsageEvent, window: { since: Date; until?: Date }): boolean =>
    event.at >= window.since && (window.until === undefined || event.at < window.until);

  const usage: NonNullable<StoreOps["usage"]> = {
    async record(event) {
      metered.push({ ...event, poolKeys: [...event.poolKeys ?? []] });
    },
    async count(query) {
      return metered.filter((event) =>
        event.action === query.action
        && inWindow(event, query)
        && (query.subject === undefined
          ? (event.poolKeys ?? []).includes(query.poolKey)
          : event.subject === query.subject)).length;
    },
    async tally(query) {
      const groups = new Map<string, UsageTallyRow>();
      for (const event of metered) {
        if (!inWindow(event, query)) continue;
        if (query.action !== undefined && event.action !== query.action) continue;
        if (query.subject !== undefined && event.subject !== query.subject) continue;
        const key = `${event.subject} ${event.action}`;
        const row = groups.get(key) ?? { subject: event.subject, action: event.action, count: 0 };
        row.count += 1;
        groups.set(key, row);
      }
      // Sorted, because "the order the events happened to arrive in" is not an
      // answer any two implementations would agree on.
      return [...groups.values()].sort((a, b) =>
        a.subject === b.subject ? a.action.localeCompare(b.action) : a.subject.localeCompare(b.subject));
    },
  };

  // ---------------------------------------------------------------------------
  // turn — a fan-out over the ops it bundles and nothing more. Written as calls
  // through the members above so the envelope cannot drift from the individual
  // ops: a rule added to one is a rule the envelope already obeys.
  // ---------------------------------------------------------------------------

  const turn: NonNullable<StoreOps["turn"]> = {
    async load(request) {
      return {
        thread: await transcripts.getThread(request.thread.id),
        index: await workspace.index(request.index),
        // Asked for or absent, the same rule the two below follow.
        ...(request.read ? { read: await workspace.read(request.read.paths, request.read) } : {}),
        ...(request.harness ? { harness: await harness.get(request.harness.appId, request.harness.subject) } : {}),
        ...(request.usage ? { usage: await usage.count(request.usage) } : {}),
      };
    },
    async commit(request) {
      const { threadId, subject, messages, title } = request.messages;
      if (request.harness) await harness.set(request.harness.appId, request.harness.subject, request.harness.state);
      return {
        messages: await transcripts.appendMessages!(threadId, subject, messages, { title }),
        ...(request.audit ? { audit: await engine.put(request.audit.collection, request.audit.record) } : {}),
      };
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
    audit,
    usage,
    secrets,
    retention,
    lifecycle,
    turn,
    /** Serialized JSON length, which is this reference's honest answer to "how
        much is in here": it grows with every row and shrinks when rows leave,
        which is the whole of what a footprint promises. */
    async footprint() {
      const measured: CollectionFootprint[] = [];
      for (const [collection, records] of collections) {
        let bytes = 0;
        for (const record of records.values()) {
          bytes += JSON.stringify({ id: record.id, data: record.data, refs: record.refs }).length;
        }
        if (bytes > 0) measured.push({ collection, kind: collectionKind(collection), bytes });
      }
      return measured.sort((a, b) => (a.collection < b.collection ? -1 : 1));
    },
    async status(): Promise<StoreWireStatus> {
      // The whole list. `ops` is a LEVEL over STORE_WIRE_PATHS' declared order,
      // so it may only run as far as the unbroken PREFIX this reference serves
      // — and the last two gaps in that prefix have now closed: the batch
      // append (op 36) is served above, and so is the retention family the list
      // used to end on. Derived from the manifest rather than typed as a
      // literal, because the number that matters is "everything declared" and a
      // hand-written one goes stale the day op 46 is added.
      // A level this reference cannot back with an op is the one thing it must
      // never report, so this moves WITH the object and never ahead of it.
      return { format: VENDO_STORE_WIRE_FORMAT, ops: Object.keys(STORE_WIRE_PATHS).length };
    },
  };
}
