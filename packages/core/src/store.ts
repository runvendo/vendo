import { z } from "zod";
import type { AuditEvent } from "./audit.js";
import type { CollectionKind } from "./engine-collections.js";
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

// ---------------------------------------------------------------------------
// IdempotencyLedger — a SERVER-SIDE capability, not a wire op.
// ---------------------------------------------------------------------------

/** The one key a replayed request is recognised by. `tenant` is separate from
    `key` because a mount that serves many tenants out of one schema would
    otherwise let one tenant's key collide with another's — and a mount that
    gives every tenant its own schema simply passes a constant. */
export interface IdempotencyScope {
  tenant: string;
  op: string;
  key: string;
}

/** What a recorded request answered, replayed verbatim to a repeat caller.
    `status` is the HTTP status the mount sent; `result` its JSON body. */
export interface IdempotencyRecord {
  status: number;
  result: Json;
}

/**
 * The replay ledger behind an `Idempotency-Key`: it remembers what a keyed
 * request answered so the same key answers the same thing instead of applying
 * the mutation twice.
 *
 * SERVER-SIDE ONLY. No client calls this and no wire op exposes it — a client
 * sends its key in a header (`STORE_WIRE_PATHS`' one mutation header) and the
 * mount is what consults the ledger.
 *
 * CONTRACT: an implementation MUST colocate the ledger with the mutations it
 * gates — the same database, reached through the same handle. A ledger that
 * lives somewhere else can commit while its mutation rolls back (or the
 * reverse), and a replay then confidently returns a result for work that never
 * happened. This is why `createStore()` hands one out instead of the ledger
 * being an adapter a host wires up separately.
 *
 * The guarantee is REPLAY protection, not mutual exclusion: two concurrent
 * requests carrying one key can both find the key fresh and both execute. That
 * is what a check-then-do ledger can promise, and saying so here is cheaper
 * than a caller discovering it in production.
 */
export interface IdempotencyLedger {
  /**
   * What this key already answered, or null when it is fresh and the caller
   * should go do the work.
   *
   * `requestHash` is the caller's own digest of the request body. Passing it in
   * — rather than reading it back out and comparing at the call site — is what
   * makes the one dangerous case impossible to skip: the SAME key with a
   * DIFFERENT body is not a replay, it is a client bug, and it throws
   * `conflict` here rather than quietly returning some other request's result.
   */
  check(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyRecord | null>;
  /** Record what this key answered. First writer wins; a later `record` for a
      key already held is ignored, never an overwrite — the answer a replay
      already received must not change under it. */
  record(scope: IdempotencyScope, requestHash: string, answer: IdempotencyRecord): Promise<void>;
}

/** 01-core §12 */
export interface StoreAdapter {
  records(collection: string): RecordStore;
  blobs(namespace: string): BlobStore;
  ensureSchema(): Promise<void>;
  /** Present when this store can serve `Idempotency-Key` replay for the
      mutations it also stores — `createStore()` provides one. OPTIONAL for the
      same reason `RecordStore.atomic` is: an adapter that cannot colocate a
      ledger says so by omitting it, and a mount that finds it absent must
      refuse keyed mutations rather than pretend they are deduplicated. */
  idempotency?: IdempotencyLedger;
}

// ---------------------------------------------------------------------------
// StoreOps — the named-operation contract for the 44-op / 12-family store.
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

// ---------------------------------------------------------------------------
// engine.list — the forward walk
// ---------------------------------------------------------------------------

/** A strict lower bound on an INDEXED field, for the one read `engine.list`'s
    newest-first page cannot serve: walking FORWARD from where a previous walk
    stopped. A meter that has already counted runs up to some instant needs
    everything after it, oldest first, so it can advance its mark as it goes.

    `field` must be one the collection registry declares indexed
    (`assertIndexedField`) — `vendo_runs.started_at` is the only one today.

    `after` is EXCLUSIVE and takes either of two forms. A caller's FIRST bound is
    a plain field VALUE ("everything since 9am"), which means strictly after that
    instant. Every bound after it is the previous page's echo
    ({@link EngineListPage}), an opaque token naming the exact row that page
    ended on: send it back VERBATIM, never parsed, never compared, never a
    timestamp to do arithmetic on. The stored value can carry more precision than
    a JS `Date` keeps, and a bound that has been round-tripped through one moves
    BACKWARDS, which re-reads a window that was already counted. */
export interface Watermark {
  field: string;
  after: string;
}

/** `engine.list`'s query: a {@link RecordQuery}, plus the one bound only the
    engine can honor. A watermark and a `cursor` are mutually exclusive and a
    call carrying both is refused — they page in opposite directions (a cursor
    walks newest-first, a watermark oldest-first), so a call with both has no
    single answer to give. */
export interface EngineListQuery extends RecordQuery {
  watermark?: Watermark;
}

/** `engine.list`'s page.

    `watermark` is present EXACTLY when a watermark bound was applied, and its
    value is the bound to send next time — an opaque RESUME TOKEN naming the last
    row of this page, or the requested `after` unchanged when the page was empty.
    A walk driven by this echo visits every row EXACTLY ONCE and terminates,
    INCLUDING rows that share the indexed field's value.

    A token rather than that value, because the value alone cannot say WHERE
    INSIDE a group of rows sharing it a page stopped, and those groups are
    routine: `vendo_runs.started_at` is caller-supplied and callers write
    `new Date().toISOString()`, so a burst of runs shares one millisecond. Asking
    for "strictly after that instant" then drops whatever was left of the group,
    silently and permanently — uncounted usage for the meter this walk exists
    for. Each implementation spells its token its own way; hand it back as
    {@link Watermark}.`after` unchanged and never parse or compare one.

    That is deliberately doing two jobs at once, and the second one is why it
    exists. Wire request bodies pass unknown keys through, so a mount older than
    the bound parses the query, ignores it, and answers with an ordinary
    newest-first page: a silently WRONG answer, not a refusal. Every other new
    op is a new PATH, and an old mount answers those with an enveloped 501 that
    says exactly what is missing — a field on an existing op has no such
    protection, and this echo is it. A caller that sent a watermark and got no
    echo back must treat the page as unserved, not as data.

    (The `/status` op count would not do here. It is a whole-mount version level
    and it can only be trusted to say a mount is BEHIND, never that it is
    complete; and it is checked before sending, which a read never needs to do —
    reads are safely retryable, which is why the batch APPEND, a mutation, is
    the one op that must feature-detect up front instead.) */
export interface EngineListPage {
  records: VendoRecord[];
  cursor?: string;
  watermark?: string;
}

// ---------------------------------------------------------------------------
// audit.list — the typed read over the audit drawer
// ---------------------------------------------------------------------------

/** Which audit rows to read. Four filters, ANDed, all optional — the ones a
    reviewer's feed and a decision tally actually narrow on, and no more.

    Narrowing by SUBJECT, app or tool is deliberately NOT here: those are
    `vendo_audit` ref keys and `engine.list("vendo_audit", { refs })` already
    serves them. This op exists for the three fields that are not refs
    (`venue` is a column, `outcome` and `decidedBy` live inside the event) plus
    `kind`, which every real feed pairs with them.

    Values are the AuditEvent's own field types, so there is no second copy of
    any of these enums to drift. */
export interface AuditQuery {
  kind?: AuditEvent["kind"];
  venue?: AuditEvent["venue"];
  outcome?: NonNullable<AuditEvent["outcome"]>;
  decidedBy?: NonNullable<AuditEvent["decidedBy"]>;
  cursor?: string;
  limit?: number;
}

/** A page of audit rows, newest first, on the SAME keyset cursor
    `engine.list("vendo_audit")` walks. Typed events rather than records: the
    audit drawer's rows are `AuditEvent`s, every consumer casts them back to one,
    and a door that returns the type it stores is a door nobody has to parse. */
export interface AuditPage {
  events: AuditEvent[];
  cursor?: string;
}

// ---------------------------------------------------------------------------
// footprint — what the store is holding
// ---------------------------------------------------------------------------

/** What one collection is holding.

    `bytes` is the size of the collection's ROW CONTENT as the engine measures
    it — not the size of a table on disk. Indexes, TOAST overhead and free pages
    are excluded, and they have to be: most collections share one table, so a
    per-collection relation size does not exist to report. The number is an
    ESTIMATE that is comparable with itself over time — it grows as the
    collection grows and never shrinks except when rows leave. Compare
    footprints; never treat one as an exact byte count, and never mix it with a
    number that came from the filesystem.

    COLLECTIONS only. Blob namespaces and workspace file content are not
    collections and are not counted here — a footprint answers "what is in the
    drawers", and a store whose bytes are mostly uploads has to ask its blob
    store, which knows. */
export interface CollectionFootprint {
  collection: string;
  kind: CollectionKind;
  bytes: number;
}

/** The scope of a destructive erase: exactly ONE of subject or appId.
    A union (not two optionals) so `erase({})` and a both-set target are
    compile errors — an erase can never run without a data scope. */
export type EraseTarget =
  | { subject: string; appId?: never }
  | { appId: string; subject?: never };

/** The typed contract for all 44 store operations across 12 families.
    Lean by design — this is the CONTRACT interface, not the implementation.

    Two members are OPTIONAL, and both mean the same thing: an implementation
    that cannot serve the family says so by OMITTING it, never by accepting the
    call and doing something else (`transcripts.appendMessages` and `retention`,
    following `RecordStore.claim`/`atomic`). Everything else is required. */
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
    list(collection: string, query?: EngineListQuery): Promise<EngineListPage>;
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
    /** Land a batch of messages on a thread this subject owns, in one call.
        `putMessage` cannot express ownership, so a client had to download the
        WHOLE thread first just to read `data.subject` — a payload that grows
        with the conversation, paid several times per turn. Naming the subject
        here moves that check into the service's own statement, and the answer
        is the thread's new revision and the number of rows written, never the
        thread itself.

        OPTIONAL for the same reason `RecordStore.claim` and `atomic` are:
        an implementation that cannot serve it says so by omitting it, and a
        caller that finds it absent takes the getThread + putMessage route. Over
        the wire the equivalent question is the `/status` op count — see
        STORE_WIRE_APPEND_MESSAGES_OPS. */
    appendMessages?(
      threadId: string,
      subject: string,
      messages: unknown[],
      opts?: { title?: string },
    ): Promise<{ revision: string; count: number }>;
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
  /** The audit drawer's own read. One verb, because reading is all anyone does
      to it: `vendo_audit` is append-only, and rows leave it only through the
      erase cascade and the retention window. */
  audit: {
    list(query?: AuditQuery): Promise<AuditPage>;
  };
  /** The store's secret vault — the values a host's connectors authenticate
      with, kept where the rest of its data is kept.
      Values cross the wire in the clear (under TLS) and are encrypted AT REST,
      server-side: an encryption key never leaves the mount, so no client can
      lose one, and a BYO store needs nothing beyond
      `VENDO_STORE_ENCRYPTION_KEY` to hold real credentials.
      `get` is the only read in the whole contract that answers with a
      credential — a mount serves it under the same authentication as a
      mutation, never as an open read. */
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    list(): Promise<string[]>;
    delete(name: string): Promise<void>;
  };
  /** Aging data out of a collection, in the two moves a recoverable sweep takes:
      `quarantine` lifts rows past the window OUT of the live collection, and
      `purge` destroys quarantined rows once the recovery grace has run out.
      Two verbs and not one because the gap between them IS the feature — a
      window that turns out to be wrong is recoverable right up until the purge.

      The engine OWNS the quarantine: where the lifted rows go, what that store
      is called and how it is shaped are the engine's business, and no caller
      ever names it. `purge` is the only way back out.

      OPTIONAL (`RecordStore.atomic`'s rule): an engine with nowhere to quarantine
      to says so by omitting the family, rather than by accepting the call and
      destroying rows a `quarantine` was supposed to keep recoverable. */
  retention?: {
    /** Rows whose age field is strictly older than `olderThan` leave the live
        collection for quarantine. Answers how many moved. Re-runnable: a second
        call with the same cutoff moves nothing. */
    quarantine(collection: string, olderThan: IsoDateTime): Promise<{ moved: number }>;
    /** Quarantined rows lifted before `quarantinedBefore` are destroyed —
        irrecoverably, which is why the cutoff is on the QUARANTINE time and not
        on the row's own age. Answers how many were destroyed. */
    purge(collection: string, quarantinedBefore: IsoDateTime): Promise<{ purged: number }>;
  };
  lifecycle: {
    erase(target: EraseTarget): Promise<unknown>;
    promote(appId: string, orgId: string): Promise<void>;
  };
  /** What this store is holding, per collection, with each collection's kind
      alongside — see {@link CollectionFootprint} for what `bytes` is and is not.
      Collections holding nothing are omitted, so an empty store answers with an
      empty list. */
  footprint(): Promise<CollectionFootprint[]>;
  status(): Promise<StoreWireStatus>;
}
