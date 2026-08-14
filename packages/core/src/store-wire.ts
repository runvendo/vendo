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
  // transcripts (7)
  "transcripts.putThread": "/transcripts/putThread",
  "transcripts.getThread": "/transcripts/getThread",
  "transcripts.listThreads": "/transcripts/listThreads",
  "transcripts.deleteThread": "/transcripts/deleteThread",
  "transcripts.putMessage": "/transcripts/putMessage",
  "transcripts.appendMessages": "/transcripts/appendMessages",
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
// engine — the collection-addressed body shape
//
// Named for its SHAPE, not for the family: `engine` takes seven verbs over a
// `collection` + args body, and the appData family addresses the same rows
// through a `target` instead. The generic records family that once shared
// these bodies is gone; its paths answer an enveloped 501.
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

/** Append a batch of messages to a thread the CALLER names the owner of, so the
    service can enforce ownership in its own statement instead of handing the
    client a whole thread to check first. The answer is `{revision, count}` and
    deliberately NOT the thread: returning it would put the entire conversation
    back on the wire on every turn, which is the cost this op exists to remove. */
export const storeWireTranscriptsAppendMessagesRequestSchema = z.object({
  threadId: z.string().min(1),
  subject: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  title: z.string().optional(),
}).passthrough();

export interface StoreWireAppendMessagesResult {
  revision: string;
  count: number;
}

/** The op count a mount must report on `/status` before a client may send
    `transcripts.appendMessages` — the 36th op, and the first one a shipped
    client has to feature-detect. The wire has no capability list and needs
    none: `/status` is already the discovery handshake, and the count is its
    only signal. Compared with `>=`, and FROZEN at the count this op shipped
    with — `===` would refuse the op the day a 37th is added, pinning every
    client on the slow path forever with nothing to see; and
    `Object.keys(STORE_WIRE_PATHS).length` would do the same from the client's
    side.

    ⚠ ADDING OP 37? READ THIS. The count is a PROXY for capability, and it
    holds only while ops are ONLY EVER ADDED. Remove one while adding another
    and the count still reaches 36 on a mount that no longer serves this op —
    the client then believes it is supported, sends it, and takes the loud 501
    this whole mechanism exists to avoid. That is not hypothetical: console
    #468 ("restore the `records.*` store wire deleted by #456") is a production
    incident from exactly that shape. Deleting a wire op means retiring this
    constant, not renumbering it.

    Detect once, cache, and route to the older getThread + putMessage path when
    the mount is behind — never send it blind and read the 501 as a fallback
    signal (#1251: a failed mutation is not a capability answer). */
export const STORE_WIRE_APPEND_MESSAGES_OPS = 36;

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

/** GET /status — the discovery handshake. Clients learn the protocol version
    and the op count. The body passes unknown keys through, so a mount that
    still sends fields this build dropped is read, not refused. */
export interface StoreWireStatus {
  format: typeof VENDO_STORE_WIRE_FORMAT;
  ops: number;
}

export const storeWireStatusSchema = z.object({
  format: z.literal(VENDO_STORE_WIRE_FORMAT),
  ops: z.number(),
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
