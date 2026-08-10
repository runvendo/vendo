import { z } from "zod";
import { VendoError, safeErrorMessage, vendoErrorCodeSchema, type VendoErrorCode } from "./errors.js";
import {
  APP_DATA_COLLECTION_PATTERN,
  APP_DATA_OWNER_PATTERN,
  recordQuerySchema,
} from "./store.js";

/** Store design v1 — the wire protocol version tag. The HTTP profile of the
    StoreOps contract, shared verbatim by the cloud client and the BYO
    `httpStore` template. */
export const VENDO_STORE_WIRE_FORMAT = "vendo/store-wire@1" as const;

/** Mount-relative endpoint paths. POST-JSON RPC for all mutations and queries;
    GET /status doubles as the discovery handshake.
    ONE Idempotency-Key header on every mutation.
    ONE keyset cursor (default 100, max 1000) on every list op.
    Unknown op → enveloped `not-implemented` (501). */
export const STORE_WIRE_PATHS = {
  // records (7)
  "records.get": "/records/get",
  "records.put": "/records/put",
  "records.delete": "/records/delete",
  "records.list": "/records/list",
  "records.claim": "/records/claim",
  "records.insertIfAbsent": "/records/insertIfAbsent",
  "records.compareAndSwap": "/records/compareAndSwap",
  // engine (7)
  "engine.get": "/engine/get",
  "engine.put": "/engine/put",
  "engine.delete": "/engine/delete",
  "engine.list": "/engine/list",
  "engine.claim": "/engine/claim",
  "engine.insertIfAbsent": "/engine/insertIfAbsent",
  "engine.compareAndSwap": "/engine/compareAndSwap",
  // blobs (4)
  "blobs.put": "/blobs/put",
  "blobs.get": "/blobs/get",
  "blobs.delete": "/blobs/delete",
  "blobs.list": "/blobs/list",
  // appData (8)
  "appData.put": "/app-data/put",
  "appData.get": "/app-data/get",
  "appData.list": "/app-data/list",
  "appData.delete": "/app-data/delete",
  "appData.putFile": "/app-data/putFile",
  "appData.getFile": "/app-data/getFile",
  "appData.listFiles": "/app-data/listFiles",
  "appData.deleteFile": "/app-data/deleteFile",
  // transcripts (6)
  "transcripts.putThread": "/transcripts/putThread",
  "transcripts.getThread": "/transcripts/getThread",
  "transcripts.listThreads": "/transcripts/listThreads",
  "transcripts.deleteThread": "/transcripts/deleteThread",
  "transcripts.putMessage": "/transcripts/putMessage",
  "transcripts.recordAnswer": "/transcripts/recordAnswer",
  // harness (3)
  "harness.get": "/harness/get",
  "harness.set": "/harness/set",
  "harness.clear": "/harness/clear",
  // workspace (4)
  "workspace.index": "/workspace/index",
  "workspace.read": "/workspace/read",
  "workspace.commit": "/workspace/commit",
  "workspace.history": "/workspace/history",
  // lifecycle (2)
  "lifecycle.erase": "/lifecycle/erase",
  "lifecycle.promote": "/lifecycle/promote",
  // status (1)
  status: "/status",
} as const;

/** The release this build of the wire ships in, advertised as
    `StoreWireStatus.minClientVersion`. Rewritten from the published package
    version by `scripts/sync-version-constants.mjs` at release cut, exactly like
    the CLI and wire VERSION constants — so it always names the release that
    carried this contract and there is no number to remember. */
export const STORE_WIRE_MIN_CLIENT_VERSION = "0.12.0";

/** The release that DROPS the ops below. Announced now, enforced there; this
    constant is the one place to change when the removal slice is cut.

    THIS NUMBER IS A PROMISE TO CUSTOMERS, not an internal note: it is printed
    verbatim in the deprecation changeset and in doctor's E-LIVE-008 warning, so
    a reader will plan a migration around it. It is derived, not chosen — the
    announcement rides the release after the one publishing today, and the
    removal must be one full release later than the announcement so nobody
    upgrades into a break they were never told about. RE-CONFIRM IT AT THE
    RELEASE CUT: if the announcement slips into a release of its own, this moves
    with it. */
export const STORE_WIRE_DEPRECATED_REMOVED_IN = "0.13.0";

/** Ops this wire still serves but is retiring: the generic `records.*` family,
    superseded by `appData.*` (owner-stamped rows generated apps invent) and
    `engine.*` (Vendo's own collections, behind an allowlist). Read off the path
    table so it cannot claim an op that does not exist — and so it empties
    itself the day `records.*` leaves. */
export const STORE_WIRE_DEPRECATED_OPS: readonly string[] =
  Object.keys(STORE_WIRE_PATHS).filter((op) => op.startsWith("records."));

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const recordInputSchema = z.object({
  id: z.string().min(1),
  data: z.unknown(),
  refs: z.record(z.string()).optional(),
}).passthrough();

const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// records + engine — one collection-addressed body shape serves both
//
// The two families take the same seven verbs over the same `collection` + args
// bodies; only the allowlist behind the door differs (engine names are gated by
// assertEngineCollection). So the bodies are named for their SHAPE, not for one
// family — a second copy would only be a copy that could drift.
// ---------------------------------------------------------------------------

export const storeWireCollectionGetRequestSchema = z.object({
  collection: z.string().min(1),
  id: z.string().min(1),
}).passthrough();

export const storeWireCollectionPutRequestSchema = z.object({
  collection: z.string().min(1),
  record: recordInputSchema,
}).passthrough();

export const storeWireCollectionDeleteRequestSchema = z.object({
  collection: z.string().min(1),
  id: z.string().min(1),
}).passthrough();

export const storeWireCollectionListRequestSchema = z.object({
  collection: z.string().min(1),
  query: recordQuerySchema.optional(),
}).passthrough();

export const storeWireCollectionClaimRequestSchema = z.object({
  collection: z.string().min(1),
  expected: recordInputSchema,
  replacement: z.object({
    data: z.unknown(),
    refs: z.record(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough();

export const storeWireCollectionInsertIfAbsentRequestSchema = z.object({
  collection: z.string().min(1),
  record: recordInputSchema,
}).passthrough();

export const storeWireCollectionCompareAndSwapRequestSchema = z.object({
  collection: z.string().min(1),
  record: recordInputSchema,
  expectedRevision: z.string().min(1),
}).passthrough();

/** @deprecated Renamed to storeWireCollection*RequestSchema — one
    collection-addressed body shape now serves both /records/* and /engine/*.
    Removed in a later slice; nothing new should import these. */
export const storeWireRecordsGetRequestSchema = storeWireCollectionGetRequestSchema;
/** @deprecated Use storeWireCollectionPutRequestSchema. */
export const storeWireRecordsPutRequestSchema = storeWireCollectionPutRequestSchema;
/** @deprecated Use storeWireCollectionDeleteRequestSchema. */
export const storeWireRecordsDeleteRequestSchema = storeWireCollectionDeleteRequestSchema;
/** @deprecated Use storeWireCollectionListRequestSchema. */
export const storeWireRecordsListRequestSchema = storeWireCollectionListRequestSchema;
/** @deprecated Use storeWireCollectionClaimRequestSchema. */
export const storeWireRecordsClaimRequestSchema = storeWireCollectionClaimRequestSchema;
/** @deprecated Use storeWireCollectionInsertIfAbsentRequestSchema. */
export const storeWireRecordsInsertIfAbsentRequestSchema = storeWireCollectionInsertIfAbsentRequestSchema;
/** @deprecated Use storeWireCollectionCompareAndSwapRequestSchema. */
export const storeWireRecordsCompareAndSwapRequestSchema = storeWireCollectionCompareAndSwapRequestSchema;

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

/** Blob bytes are base64-encoded on the wire. */
export const storeWireBlobsPutRequestSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  bytes: z.string().min(1), // base64
  contentType: z.string().optional(),
}).passthrough();

export const storeWireBlobsGetRequestSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
}).passthrough();

export const storeWireBlobsDeleteRequestSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
}).passthrough();

export const storeWireBlobsListRequestSchema = z.object({
  namespace: z.string().min(1),
  prefix: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// appData
// ---------------------------------------------------------------------------

/** The owner on the target is the runtime's stamp from the host's login
    session, never something generated code names. Fenced by
    `APP_DATA_OWNER_PATTERN` because it is the first path segment of every
    appData file key, so a "/" in it crosses into another owner's drawer. */
export const appDataTargetSchema = z.object({
  appId: z.string().min(1),
  collection: z.string().regex(APP_DATA_COLLECTION_PATTERN),
  owner: z.string().regex(APP_DATA_OWNER_PATTERN),
}).passthrough();

export const storeWireAppDataPutRequestSchema = z.object({
  target: appDataTargetSchema,
  record: recordInputSchema,
}).passthrough();

export const storeWireAppDataGetRequestSchema = z.object({
  target: appDataTargetSchema,
  id: z.string().min(1),
}).passthrough();

export const storeWireAppDataListRequestSchema = z.object({
  target: appDataTargetSchema,
  query: recordQuerySchema.optional(),
}).passthrough();

export const storeWireAppDataDeleteRequestSchema = z.object({
  target: appDataTargetSchema,
  id: z.string().min(1),
}).passthrough();

/** File bytes are base64-encoded on the wire, exactly like `blobs.put`. */
export const storeWireAppDataPutFileRequestSchema = z.object({
  target: appDataTargetSchema,
  key: z.string().min(1),
  bytes: z.string().min(1), // base64
  contentType: z.string().optional(),
}).passthrough();

export const storeWireAppDataGetFileRequestSchema = z.object({
  target: appDataTargetSchema,
  key: z.string().min(1),
}).passthrough();

export const storeWireAppDataListFilesRequestSchema = z.object({
  target: appDataTargetSchema,
  prefix: z.string().optional(),
}).passthrough();

export const storeWireAppDataDeleteFileRequestSchema = z.object({
  target: appDataTargetSchema,
  key: z.string().min(1),
}).passthrough();

// ---------------------------------------------------------------------------
// transcripts
// ---------------------------------------------------------------------------

export const storeWireTranscriptsPutThreadRequestSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    subject: z.string().min(1),
    messages: z.array(z.unknown()),
    title: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const storeWireTranscriptsGetThreadRequestSchema = z.object({
  id: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).passthrough();

export const storeWireTranscriptsListThreadsRequestSchema = z.object({
  subject: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).passthrough();

export const storeWireTranscriptsDeleteThreadRequestSchema = z.object({
  id: z.string().min(1),
}).passthrough();

export const storeWireTranscriptsPutMessageRequestSchema = z.object({
  threadId: z.string().min(1),
  message: z.unknown(),
}).passthrough();

export const storeWireTranscriptsRecordAnswerRequestSchema = z.object({
  threadId: z.string().min(1),
  answer: z.unknown(),
}).passthrough();

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

export const storeWireHarnessGetRequestSchema = z.object({
  appId: z.string().min(1),
  subject: z.string().min(1),
}).passthrough();

export const storeWireHarnessSetRequestSchema = z.object({
  appId: z.string().min(1),
  subject: z.string().min(1),
  state: z.unknown(),
}).passthrough();

export const storeWireHarnessClearRequestSchema = z.object({
  appId: z.string().min(1),
  subject: z.string().min(1),
}).passthrough();

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

/** The owner whose drawer a workspace op addresses: the end user (or org) the
    files belong to, the way every other op family already names its subject.
    Optional here because a single-player mount binds its one owner at
    construction; a mount serving more than one user always sends it, or its
    whole user base shares one drawer. */
const ownerField = { owner: z.string().min(1).optional() };

/** One committed change to one path: new content, or a tombstone that removes
    it (deletion was otherwise inexpressible over the wire). `expectedRevision`
    makes the write a strict compare-and-swap against the revision the caller
    read — the `/orgs` mounts' policy — and a stale one refuses the commit.
    It has THREE states: a number compares, `null` is the create-only guard
    ("the caller read nothing here, so this path must not exist yet"), and the
    absent field is unguarded. Without `null` a caller who checked out before
    the file existed had no way to say so, and the guard degraded into an
    unguarded write that silently overwrote whoever created it first.
    `data` stays unknown: content is the caller's JSON, with binary riding the
    `{"$vendoWorkspaceBytes": base64}` envelope. */
export const storeWireWorkspaceEntrySchema = z.object({
  path: z.string().min(1),
  data: z.unknown(),
  delete: z.literal(true).optional(),
  expectedRevision: z.number().int().min(0).nullable().optional(),
}).passthrough();

export const storeWireWorkspaceIndexRequestSchema = cursorQuerySchema.extend(ownerField);

export const storeWireWorkspaceReadRequestSchema = z.object({
  ...ownerField,
  paths: z.array(z.string().min(1)).min(1),
}).passthrough();

export const storeWireWorkspaceCommitRequestSchema = z.object({
  ...ownerField,
  entries: z.array(storeWireWorkspaceEntrySchema).min(1),
}).passthrough();

/** `path` narrows the page to the commits that touched it (newest first, same
    keyset cursor); without it the page is the whole commit ledger. */
export const storeWireWorkspaceHistoryRequestSchema = cursorQuerySchema.extend({
  ...ownerField,
  path: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Exactly ONE of subject/appId — an erase with no scope (or an ambiguous
    both-set scope) is a destructive call with no target and must be rejected. */
export const storeWireLifecycleEraseRequestSchema = z.object({
  target: z.object({
    subject: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
  }).passthrough().refine(
    (t) => (t.subject === undefined) !== (t.appId === undefined),
    { message: "erase target must set exactly one of subject or appId" },
  ),
}).passthrough();

export const storeWireLifecyclePromoteRequestSchema = z.object({
  appId: z.string().min(1),
  orgId: z.string().min(1),
}).passthrough();

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** GET /status — the discovery handshake. Clients learn the protocol version,
    the min client version for negotiation, and counts. */
export interface StoreWireStatus {
  format: typeof VENDO_STORE_WIRE_FORMAT;
  minClientVersion?: string;
  ops: number;
  /** Op names this mount still serves but is retiring. */
  deprecated?: readonly string[];
}

export const storeWireStatusSchema = z.object({
  format: z.literal(VENDO_STORE_WIRE_FORMAT),
  minClientVersion: z.string().optional(),
  ops: z.number(),
  deprecated: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<StoreWireStatus>;

// ---------------------------------------------------------------------------
// Error envelope (identical shape to knowledge-wire / umbrella wire)
// ---------------------------------------------------------------------------

export interface StoreWireError {
  error: {
    code: VendoErrorCode;
    message: string;
  };
}

export const storeWireErrorSchema = z.object({
  error: z.object({
    code: vendoErrorCodeSchema,
    message: z.string(),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<StoreWireError>;

/** Mirrors the umbrella wire's STATUS_BY_CODE — core cannot import it
    (layering: core depends on nothing). */
export const STORE_WIRE_STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  forbidden: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
};

/** 404 is deliberately absent: only an ENVELOPED `not-found` may become the
    record-absence code. A bare 404 is a mount/deployment failure and degrades
    to "not-implemented" so it surfaces as an error. */
const STATUS_TO_CODE: Record<number, VendoErrorCode> = {
  400: "validation",
  402: "cloud-required",
  403: "blocked",
  409: "conflict",
};

/** Server half: one VendoError → the enveloped body + HTTP status. */
export function storeWireErrorBody(error: VendoError): { status: number; body: StoreWireError } {
  return {
    status: STORE_WIRE_STATUS_BY_CODE[error.code],
    body: { error: { code: error.code, message: safeErrorMessage(error) } },
  };
}

/** Client half: a non-2xx response → VendoError. An enveloped wire-legal
    code wins over the bare status; recognized statuses map through
    STATUS_TO_CODE; anything else degrades to "not-implemented". */
export function parseStoreWireError(status: number, body: unknown): VendoError {
  const parsed = storeWireErrorSchema.safeParse(body);
  if (parsed.success) {
    return new VendoError(parsed.data.error.code, parsed.data.error.message);
  }
  const code = STATUS_TO_CODE[status];
  if (code !== undefined) {
    return new VendoError(code, `store wire request failed with HTTP ${status}`);
  }
  return new VendoError("not-implemented", `store wire request failed with HTTP ${status}`);
}
