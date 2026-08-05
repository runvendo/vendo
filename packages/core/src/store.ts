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
// StoreOps — the named-operation contract for the 32-op / 7-family store.
// Both the local backend (store/ops.ts) and the cloud client
// (hosted-store.ts) implement this interface.
// ---------------------------------------------------------------------------

import type { StoreWireStatus } from "./store-wire.js";

/** The scope of a destructive erase: exactly ONE of subject or appId.
    A union (not two optionals) so `erase({})` and a both-set target are
    compile errors — an erase can never run without a data scope. */
export type EraseTarget =
  | { subject: string; appId?: never }
  | { appId: string; subject?: never };

/** The typed contract for all 32 store operations across 7 families.
    Lean by design — this is the CONTRACT interface, not the implementation. */
export interface StoreOps {
  records: {
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
  workspace: {
    index(query?: { cursor?: string; limit?: number }): Promise<{ entries: unknown[]; cursor?: string }>;
    read(paths: string[]): Promise<Record<string, unknown>>;
    commit(entries: unknown[], opts?: { idempotencyKey?: string }): Promise<void>;
    history(query?: { cursor?: string; limit?: number }): Promise<{ entries: unknown[]; cursor?: string }>;
    undo(commitId: string): Promise<void>;
  };
  lifecycle: {
    erase(target: EraseTarget): Promise<unknown>;
    adopt(from: string, to: string): Promise<unknown>;
    promote(appId: string, orgId: string): Promise<void>;
    sessionRegister(subject: string, now?: number): Promise<void>;
    sessionStale(idleMs: number, now?: number): Promise<string[]>;
    sessionClaim(subject: string, idleMs: number, now?: number): Promise<boolean>;
  };
  status(): Promise<StoreWireStatus>;
}
