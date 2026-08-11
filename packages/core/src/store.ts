import { z } from "zod";
import { isoDateTimeSchema, type IsoDateTime, type Json } from "./ids.js";

const requiredJsonValueSchema = z.unknown().refine(
  (value) => value !== undefined,
  { message: "required JSON value is missing" },
) as z.ZodType<{}>;

/** 01-core §12 */
export interface VendoRecord {
  id: string;
  data: Json;
  refs?: Record<string, string>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Opaque concurrency token, present when the record store exposes `atomic`. */
  revision?: string;
}

/** 01-core §12 */
export const vendoRecordSchema = z.object({
  id: z.string(),
  data: requiredJsonValueSchema,
  refs: z.record(z.string()).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  revision: z.string().optional(),
}).passthrough() satisfies z.ZodType<VendoRecord>;

/** 01-core §12 */
export interface RecordQuery {
  refs?: Record<string, string>;
  ids?: string[];
  limit?: number;
  cursor?: string;
}

/** 01-core §12 */
export const recordQuerySchema = z.object({
  refs: z.record(z.string()).optional(),
  ids: z.array(z.string()).optional(),
  limit: z.number().optional(),
  cursor: z.string().optional(),
}).passthrough() satisfies z.ZodType<RecordQuery>;

export type RecordInput = Pick<VendoRecord, "id" | "data" | "refs">;

/** Optional additive capability for cross-process atomic record claims and updates. */
export interface AtomicRecordStore {
  /** Inserts only when the id is absent. Returns null when another caller won. */
  insertIfAbsent(record: RecordInput): Promise<VendoRecord | null>;
  /** Replaces only the matching revision. Returns null when the token is stale or absent. */
  compareAndSwap(record: RecordInput, expectedRevision: string): Promise<VendoRecord | null>;
}

/** 01-core §12 */
export interface RecordStore {
  get(id: string): Promise<VendoRecord | null>;
  put(record: RecordInput): Promise<VendoRecord>;
  /**
   * Atomically replace or delete a record only when its current data and refs
   * still equal `expected`. Returns true for the single successful claimant.
   * Omitted by adapters that cannot provide a database-level compare-and-claim.
   */
  claim?(
    expected: RecordInput,
    replacement?: Pick<VendoRecord, "data" | "refs">,
  ): Promise<boolean>;
  delete(id: string): Promise<void>;
  list(query?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
  /** Absent adapters retain ordinary single-instance read/put behavior. */
  atomic?: AtomicRecordStore;
}

/** 01-core §12 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/** 01-core §12 */
export interface StoreAdapter {
  records(collection: string): RecordStore;
  blobs(namespace: string): BlobStore;
  ensureSchema(): Promise<void>;
}

// ---------------------------------------------------------------------------
// StoreOps — the named-operation contract for the 35-op / 8-family store.
// Both the local backend (store/ops.ts) and the cloud client
// (hosted-store.ts) implement this interface.
// ---------------------------------------------------------------------------

import type { StoreWireStatus } from "./store-wire.js";

/** The grammar a collection name invented by generated code must satisfy:
    a short slug, optionally `box:`-prefixed. */
export const APP_DATA_COLLECTION_PATTERN = /^(box:)?[A-Za-z0-9_-]{1,64}$/;

/** The grammar an appData owner must satisfy: non-empty and free of "/".
    Deliberately NOT a slug — a subject is the host's own user id in the host's
    own spelling, and `auth0|64f…`, `user:with:colons` and
    `https://idp.example/u/1` are all contract elsewhere in this repo. "/" is
    the one character that cannot be allowed here, because appData files carry
    their owner as the first path segment of the blob key (`<owner>/<key>`):
    owner `a/b` and owner `a` writing `b/…` are the same key, so a "/" in an
    owner is a silent cross-user file read. Refused, never rewritten — a
    sanitised owner would map two people onto one drawer. */
export const APP_DATA_OWNER_PATTERN = /^[^/]+$/;

/** Where one appData op lands. */
export interface AppDataTarget {
  appId: string;
  collection: string;
  /** Stamped by the RUNTIME from the host's login session — generated code has
      no field for it, and a caller that supplies `refs.subject` is refused.
      Must satisfy {@link APP_DATA_OWNER_PATTERN}. */
  owner: string;
}

/** The scope of a destructive erase: exactly ONE of subject or appId.
    A union (not two optionals) so `erase({})` and a both-set target are
    compile errors — an erase can never run without a data scope. */
export type EraseTarget =
  | { subject: string; appId?: never }
  | { appId: string; subject?: never };

/** The typed contract for all 35 store operations across 8 families.
    Lean by design — this is the CONTRACT interface, not the implementation. */
export interface StoreOps {
  /** Vendo's OWN engine data — grants, approvals, audit, threads, runs, apps,
      effects, and the automations and guard drawers — reached through seven
      collection-addressed verbs. `assertEngineCollection`
      (engine-collections.ts) gates the collection name on every verb, so
      nothing outside the allowlist passes. NOT a place for host or
      generated-app data: that is `appData`. */
  engine: {
    get(collection: string, id: string): Promise<VendoRecord | null>;
    put(collection: string, record: RecordInput): Promise<VendoRecord>;
    delete(collection: string, id: string): Promise<void>;
    list(collection: string, query?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
    claim(collection: string, expected: RecordInput, replacement?: Pick<VendoRecord, "data" | "refs">): Promise<boolean>;
    insertIfAbsent(collection: string, record: RecordInput): Promise<VendoRecord | null>;
    compareAndSwap(collection: string, record: RecordInput, expectedRevision: string): Promise<VendoRecord | null>;
  };
  blobs: {
    put(namespace: string, key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
    get(namespace: string, key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null>;
    delete(namespace: string, key: string): Promise<void>;
    list(namespace: string, prefix?: string): Promise<string[]>;
  };
  /** Everything generated apps invent. Reads are auto-scoped to the target's
      owner and writes are stamped with it, so no verb here takes a subject. */
  appData: {
    put(target: AppDataTarget, record: RecordInput): Promise<VendoRecord>;
    get(target: AppDataTarget, id: string): Promise<VendoRecord | null>;
    list(target: AppDataTarget, query?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
    delete(target: AppDataTarget, id: string): Promise<void>;
    putFile(target: AppDataTarget, key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
    getFile(target: AppDataTarget, key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null>;
    listFiles(target: AppDataTarget, prefix?: string): Promise<string[]>;
    deleteFile(target: AppDataTarget, key: string): Promise<void>;
  };
  transcripts: {
    putThread(thread: { id: string; subject: string; messages: unknown[]; title?: string }): Promise<VendoRecord>;
    getThread(id: string, opts?: { cursor?: string; limit?: number }): Promise<VendoRecord | null>;
    listThreads(query?: { subject?: string; cursor?: string; limit?: number }): Promise<{ records: VendoRecord[]; cursor?: string }>;
    deleteThread(id: string): Promise<void>;
    putMessage(threadId: string, message: unknown): Promise<VendoRecord>;
    recordAnswer(threadId: string, answer: unknown): Promise<VendoRecord>;
  };
  harness: {
    get(appId: string, subject: string): Promise<unknown | null>;
    set(appId: string, subject: string, state: unknown): Promise<void>;
    clear(appId: string, subject: string): Promise<void>;
  };
  /** Every workspace verb names its OWNER — the end user (or org) whose drawer
      the files live in, exactly as conversations, records and blobs already do.
      Omitted, the backend falls back to the owner it was constructed with, which
      is the single-player local default; a multi-user hosted mount always passes
      one, or its whole user base shares one drawer.

      Entries are `{ path, data?, delete?, expectedRevision? }`: `delete: true` is
      a tombstone (deletion is otherwise inexpressible), and `expectedRevision` is
      the strict compare-and-swap the `/orgs` mounts commit under — a stale one
      refuses the WHOLE commit with `conflict`, so the caller re-reads once.
      Binary content rides `{"$vendoWorkspaceBytes": base64, contentType?}`. */
  workspace: {
    index(query?: { cursor?: string; limit?: number; owner?: string }): Promise<{ entries: unknown[]; cursor?: string }>;
    read(paths: string[], opts?: { owner?: string }): Promise<Record<string, unknown>>;
    commit(entries: unknown[], opts?: { idempotencyKey?: string; owner?: string }): Promise<void>;
    /** Naming a `path` narrows history to the commits that touched it, newest
        first, and each entry then also carries the `revision` that path held
        BEFORE the commit — absent when the commit created it, which is what
        makes a create distinguishable from an overwrite in the trail. */
    history(query?: { cursor?: string; limit?: number; owner?: string; path?: string }): Promise<{ entries: unknown[]; cursor?: string }>;
  };
  lifecycle: {
    erase(target: EraseTarget): Promise<unknown>;
    promote(appId: string, orgId: string): Promise<void>;
  };
  status(): Promise<StoreWireStatus>;
}
