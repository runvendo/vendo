import { z } from "zod";
import { VendoError, safeErrorMessage, vendoErrorCodeSchema, type VendoErrorCode } from "./errors.js";
import { isoDateTimeSchema, type Json } from "./ids.js";
import { limitActionSchema } from "./limits.js";
import {
  APP_DATA_COLLECTION_PATTERN,
  APP_DATA_OWNER_PATTERN,
  recordQuerySchema,
  vendoRecordSchema,
  type TurnCommit,
  type TurnLoad,
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
  // ⚠ erase is the ONE door not under its family prefix, and that is the
  // point: it shipped at `/erase` before the wire had families, and every
  // mount — the console included — serves it there and nowhere else. This
  // manifest records the door that EXISTS. Tidying it to `/lifecycle/erase`
  // makes it a route no client calls and no service answers, so a third party
  // that builds its mount from this table never receives an erase at all.
  "lifecycle.erase": "/erase",
  "lifecycle.promote": "/lifecycle/promote",
  // audit (1 of 2 — `audit.tally` is the newest op and rides the tail, below)
  "audit.list": "/audit/list",
  // secrets (4)
  "secrets.get": "/secrets/get",
  "secrets.set": "/secrets/set",
  "secrets.list": "/secrets/list",
  "secrets.delete": "/secrets/delete",
  // footprint (1)
  footprint: "/footprint",
  // retention (2) — LAST on purpose, and not because of the family's name.
  // `ops` on /status is a monotone LEVEL over this list (see below), so the ops
  // an engine may legitimately not serve yet have to be its tail, or a mount
  // that stops short of them cannot report an honest number.
  "retention.quarantine": "/retention/quarantine",
  "retention.purge": "/retention/purge",
  // status (1)
  status: "/status",
  // audit.tally (1) — declared AFTER `status`, which is not a filing mistake.
  // `ops` is a monotone level over THIS order, so a number a shipped mount is
  // already reporting must keep meaning what it meant: appending is the only
  // edit that cannot re-date one. Slot this op anywhere earlier and every mount
  // reporting 44 today ("everything through /status") starts claiming a tally
  // it has never served — the renumbering hazard
  // STORE_WIRE_APPEND_MESSAGES_OPS spells out below, arriving from the other
  // direction. Its cost is the level's known coarseness: an engine that stops
  // short of retention can serve this op and still not be able to say so, which
  // is fine, because a missing op is read off its own 501 and never off the
  // level.
  "audit.tally": "/audit/tally",
  // usage (3) — the meter behind per-user limits, appended for the same reason
  // `audit.tally` was: the level may only ever grow, so a new family goes on
  // the end and a mount that stops short of it keeps reporting the number it
  // always did.
  "usage.record": "/usage/record",
  "usage.count": "/usage/count",
  "usage.tally": "/usage/tally",
  // turn (2) — the two cross-family envelopes, appended for the reason every
  // family since `audit.tally` was: the level may only ever grow.
  "turn.load": "/turn/load",
  "turn.commit": "/turn/commit",
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

/** The forward-walk bound. `after` is an opaque string, NOT a datetime: it is
    echoed back verbatim from a previous page, and validating it as a datetime
    here would quietly re-encode a value whose extra precision is the whole
    point (see `Watermark` in store.ts). */
export const storeWireWatermarkSchema = z.object({
  field: z.string().min(1),
  after: z.string().min(1),
}).passthrough();

/** `engine.list`'s query. A watermark pages oldest-first from its bound and a
    cursor pages newest-first from its own; a body carrying both is asking for
    two different walks at once and is refused here rather than resolved by a
    precedence rule nobody could guess. */
export const engineListQuerySchema = recordQuerySchema.extend({
  watermark: storeWireWatermarkSchema.optional(),
}).refine(
  (query) => query.watermark === undefined || query.cursor === undefined,
  { message: "engine.list takes a watermark or a cursor, never both — they page in opposite directions" },
);

export const storeWireCollectionListRequestSchema = z.object({
  collection: z.string().min(1),
  query: engineListQuerySchema.optional(),
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

/** Blob bytes are base64-encoded on the wire. `bytes` carries no `.min(1)`:
    base64 of a ZERO-BYTE payload is the empty string, and an empty file is
    content — an empty upload, a truncated log, a placeholder an app wrote.
    Refusing it here made the one thing a store must never do (lose a
    successful write) into the client's default: the put failed, and the
    caller's `get` then answered null exactly as it would for a key nobody had
    ever written. Both local implementations always accepted it; this line is
    where the wire stopped disagreeing with them. */
export const storeWireBlobsPutRequestSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  bytes: z.string(), // base64
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

/** An id, and nothing else. `getThread` answers with ONE record and the wire's
    read answer has no field a next-page cursor could ride, so the `cursor` and
    `limit` this schema used to declare were a windowing request no mount could
    complete — the client sent them, every implementation ignored them, and the
    caller got the whole transcript back with no way to tell. Retired rather
    than implemented: paging a transcript needs an answer shaped to say "there
    is more", which is a different op. `.passthrough()` means a client that
    still sends them is read, not refused. */
export const storeWireTranscriptsGetThreadRequestSchema = z.object({
  id: z.string().min(1),
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
    signal (#1251: a failed mutation is not a capability answer).

    ⚠ AND A SECOND CONSTANT OF THIS KIND MUST CLEAR THE BAR BELOW — only
    STORE_WIRE_TURN_OPS ever has. Ops 37-48 (audit, secrets, footprint,
    retention, the audit tally, usage) added no twin, and most ops should not.
    A pre-send check earns its keep only when sending blind is
    unsafe, and that is true of exactly one shape: a MUTATION with a cheaper
    fallback, where a 501 leaves the caller unable to tell "never ran" from
    "ran and failed". Every one of 37-45 is a new PATH, so an older mount
    refuses it with the enveloped 501 this protocol already answers unknown ops
    with — loud, specific, and impossible to mistake for data. The one
    genuinely invisible addition, the watermark bound on `engine.list`, is a
    FIELD on an existing op that `.passthrough()` would let an old mount ignore
    in silence; it is detected by the echo on its own answer
    (`EngineListPage.watermark`), not from here. */
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

/** The scope rides the body FLAT, the way the shipped door reads it — no
    `target` wrapper. Exactly ONE of subject/appId: an erase with no scope (or
    an ambiguous both-set scope) is a destructive call with no target and must
    be rejected. */
export const storeWireLifecycleEraseRequestSchema = z.object({
  subject: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
}).passthrough().refine(
  (target) => (target.subject === undefined) !== (target.appId === undefined),
  { message: "erase target must set exactly one of subject or appId" },
);

export const storeWireLifecyclePromoteRequestSchema = z.object({
  appId: z.string().min(1),
  orgId: z.string().min(1),
}).passthrough();

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/** The four filters, ANDed and every one optional — ONE copy, shared by the
    feed and the tally the way `AuditFilters` is shared on the contract side: a
    WHERE spelled twice is a WHERE that drifts, and a tally that counts a
    different set of rows than the feed shows is the drift nobody can see.
    The enums are spelled here rather than imported from `auditEventSchema`
    because this is the REQUEST, and a request that names a kind this build has
    not heard of should be refused by the mount's own validation, not silently
    widened. */
const auditFilterFields = {
  kind: z.enum(["tool-call", "approval", "policy-decision", "run", "app-lifecycle", "share", "door-auth", "principal"]).optional(),
  venue: z.enum(["chat", "app", "automation", "mcp"]).optional(),
  outcome: z.enum(["ok", "error", "pending-approval", "blocked", "connect-required"]).optional(),
  decidedBy: z.enum(["grant", "rule", "judge", "default", "confirmEach", "breaker", "denied", "org", "frozen"]).optional(),
};

/** An empty body is the whole feed, newest first. */
export const storeWireAuditListRequestSchema = cursorQuerySchema.extend(auditFilterFields);

/** The tally's body: the same four filters, and `from` INSTEAD of a page.
    A real datetime (like retention's cutoffs, unlike a watermark's opaque
    echo): it is a window the caller authored, not a value it read back. Not
    optional — a tally has no cursor, so this floor is the only thing bounding
    the answer, and a body without one asks a mount to group an append-only
    drawer's whole history. */
export const storeWireAuditTallyRequestSchema = z.object({
  ...auditFilterFields,
  from: isoDateTimeSchema,
}).passthrough();

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

/** One metered action, as it happened. `at` is a real datetime the caller
    authored, and `poolKeys` are the shared buckets this action ALSO drew down,
    sent WITH the write rather than looked up at read time: a member who leaves
    a team must not retroactively drain its quota. */
export const storeWireUsageRecordRequestSchema = z.object({
  subject: z.string().min(1),
  action: limitActionSchema,
  at: isoDateTimeSchema,
  poolKeys: z.array(z.string().min(1)).optional(),
}).passthrough();

/** Exactly ONE of subject/poolKey (`lifecycle.erase`'s rule): a count is either
    a person's or a pool's, and a body carrying both — or neither — asks for two
    numbers under one name. `since` is required and inclusive for
    `audit.tally`'s reason: it is the only bound on a drawer that only grows. */
export const storeWireUsageCountRequestSchema = z.object({
  action: limitActionSchema,
  since: isoDateTimeSchema,
  until: isoDateTimeSchema.optional(),
  subject: z.string().min(1).optional(),
  poolKey: z.string().min(1).optional(),
}).passthrough().refine(
  (query) => (query.subject === undefined) !== (query.poolKey === undefined),
  { message: "usage count must set exactly one of subject or poolKey" },
);

/** The same window counted per subject instead of for one. Both narrowings are
    optional here precisely because the answer names both. */
export const storeWireUsageTallyRequestSchema = z.object({
  since: isoDateTimeSchema,
  until: isoDateTimeSchema.optional(),
  action: limitActionSchema.optional(),
  subject: z.string().min(1).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// secrets
//
// The value rides the body in the clear — TLS is the transport's job and the
// mount encrypts at rest. `secrets.get` is the one read in this protocol that
// answers with a credential; a mount authenticates it like a mutation.
// ---------------------------------------------------------------------------

export const storeWireSecretsGetRequestSchema = z.object({
  name: z.string().min(1),
}).passthrough();

export const storeWireSecretsSetRequestSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
}).passthrough();

/** No filter and no page: a vault small enough to need one is not a vault. */
export const storeWireSecretsListRequestSchema = z.object({}).passthrough();

export const storeWireSecretsDeleteRequestSchema = z.object({
  name: z.string().min(1),
}).passthrough();

// ---------------------------------------------------------------------------
// footprint
// ---------------------------------------------------------------------------

/** No arguments: the answer is the whole store, and a caller that wants one
    collection reads one entry out of it. */
export const storeWireFootprintRequestSchema = z.object({}).passthrough();

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

/** Rows older than the cutoff leave the live collection. The cutoff is a real
    datetime here (unlike a watermark, which is an opaque echo): it is a policy
    the caller authored, not a value it read back. */
export const storeWireRetentionQuarantineRequestSchema = z.object({
  collection: z.string().min(1),
  olderThan: isoDateTimeSchema,
}).passthrough();

/** The cutoff is on the QUARANTINE time, not the row's age — this verb destroys
    rows, and the recovery grace it honors is measured from when they were
    lifted. */
export const storeWireRetentionPurgeRequestSchema = z.object({
  collection: z.string().min(1),
  quarantinedBefore: isoDateTimeSchema,
}).passthrough();

// ---------------------------------------------------------------------------
// turn — one call at the start of an agent turn, one at the end
//
// Both bodies are COMPOSITION: every part is the very schema its own op takes,
// and every answer is the very shape its own op returns. A part a caller does
// not need is omitted from the request and then absent from the answer, so
// asking for less costs less. Nothing here is new semantics — an envelope that
// invented a shape would be a second contract to keep in step with the first.
// ---------------------------------------------------------------------------

export const storeWireTurnLoadRequestSchema = z.object({
  thread: storeWireTranscriptsGetThreadRequestSchema,
  index: storeWireWorkspaceIndexRequestSchema,
  read: storeWireWorkspaceReadRequestSchema.optional(),
  harness: storeWireHarnessGetRequestSchema.optional(),
  usage: storeWireUsageCountRequestSchema.optional(),
}).passthrough();

export const storeWireTurnLoadResponseSchema = z.object({
  thread: vendoRecordSchema.nullable(),
  index: z.object({
    entries: z.array(z.unknown()),
    cursor: z.string().optional(),
  }).passthrough(),
  read: z.record(z.unknown()).optional(),
  harness: z.unknown().optional(),
  usage: z.number().optional(),
}).passthrough() satisfies z.ZodType<TurnLoad>;

export const storeWireTurnCommitRequestSchema = z.object({
  messages: storeWireTranscriptsAppendMessagesRequestSchema,
  harness: storeWireHarnessSetRequestSchema.optional(),
  audit: storeWireCollectionPutRequestSchema.optional(),
}).passthrough();

/** `harness.set` answers nothing, so the envelope answers nothing for it. */
export const storeWireTurnCommitResponseSchema = z.object({
  messages: z.object({
    revision: z.string(),
    count: z.number().int(),
  }).passthrough(),
  audit: vendoRecordSchema.optional(),
}).passthrough() satisfies z.ZodType<TurnCommit>;

/** The op count a mount must report on `/status` before a client may send the
    turn envelopes — read with `>=` and FROZEN, exactly as
    {@link STORE_WIRE_APPEND_MESSAGES_OPS} is, and for its reasons.
    `turn.commit` is the shape that warrants a pre-send check: a MUTATION with a
    cheaper fallback (the individual ops), where a 501 leaves the caller unable
    to tell "never ran" from "ran and failed". `turn.load` is a read that could
    be sent blind, but the two ship as one family on one level. */
export const STORE_WIRE_TURN_OPS = 50;

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** GET /status — the discovery handshake. Clients learn the protocol version
    and the op count. The body passes unknown keys through, so a mount that
    still sends fields this build dropped is read, not refused.

    `ops` is a LEVEL, not an inventory: how far down STORE_WIRE_PATHS' declared
    order this mount serves. It answers "are you at least as new as X" and
    nothing finer — there is no way to say "all but one in the middle", which is
    why the ops an engine may not have yet are declared last. Read it with `>=`
    against a frozen constant, and read a missing op's absence off its own 501. */
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

/** `detail` is `VendoError.detail`, and it crosses. Without it a refusal
    arrived over the wire as a code and a sentence, so every structured payload
    a refusal carried was readable by a local caller and lost to a hosted one:
    `workspace.commit`'s conflict names the paths that moved in `detail.conflicts`,
    and the hosted path had to re-read the whole index and re-derive them by
    hand (`workspace-ops-rows.ts`). Optional, and passed through untouched — a
    mount that sends none and a client that ignores one both stay legal. */
export interface StoreWireError {
  error: {
    code: VendoErrorCode;
    message: string;
    detail?: unknown;
  };
}

export const storeWireErrorSchema = z.object({
  error: z.object({
    code: vendoErrorCodeSchema,
    message: z.string(),
    detail: z.unknown().optional(),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<StoreWireError>;

/** What a client can do with an answer, declared on EVERY request it sends so a
    mount never sends a shape the client cannot read. Comma-separated and
    ADDITIVE — a mount reads it as a set and ignores names it does not know, a
    client omits names it does not implement — which is what lets a mount grow an
    answer shape without a version bump. Scoped to the store wire: the other
    Cloud wires declare nothing, and managed inference does not carry Vendo
    headers at all. */
export const STORE_WIRE_CAPABILITIES_HEADER = "x-vendo-store-capabilities";

/** The capabilities THIS build implements — today, only the schema-proposal
    handshake below. */
export const STORE_WIRE_CAPABILITIES = "schema-proposal";

/** A typed mount's answer to a write against a table it has not been told
    about: HTTP 409 carrying the DDL that would make the write legal, instead of
    applying the write. `error` is the literal STRING "schema-proposal" — that is
    what discriminates this body from {@link StoreWireError}, whose `error` is an
    object, and the two have to be told apart by shape because they share a
    status.

    The proposal is passed through UNTOUCHED: the client forwards it verbatim to
    the mount's schema door, so only the two fields it reads to explain itself
    are typed here and every other field crosses on unread. */
export interface StoreWireSchemaProposal {
  error: "schema-proposal";
  proposal: { op: string; table: string };
}

export const storeWireSchemaProposalSchema = z.object({
  error: z.literal("schema-proposal"),
  proposal: z.object({
    op: z.string(),
    table: z.string(),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<StoreWireSchemaProposal>;

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
  unavailable: 503,
  // The proposal's own status. A mount that serves the handshake sends the
  // PROPOSAL body rather than this envelope; the entry exists so an exhausted
  // handshake re-crossing a wire keeps the status it arrived on.
  "schema-proposal": 409,
};

/** 404 is deliberately absent: only an ENVELOPED `not-found` may become the
    record-absence code. A bare 404 is a mount/deployment failure and degrades
    to "not-implemented" so it surfaces as an error.
    429/500/502/503/504 map to `unavailable` — a transient failure on the
    server's own dependency, never "this op does not exist". Field 2026-08-14:
    a dropped Postgres connection under load answered 503, and BEFORE this
    entry existed that fell all the way through to "not-implemented", which
    told the operator the Cloud store did not support a batch-append op it
    shipped with — sending the first look at the incident at the version-skew
    path instead of the real one. */
const STATUS_TO_CODE: Record<number, VendoErrorCode> = {
  400: "validation",
  402: "cloud-required",
  403: "blocked",
  409: "conflict",
  429: "unavailable",
  500: "unavailable",
  502: "unavailable",
  503: "unavailable",
  504: "unavailable",
};

/** Server half: one VendoError → the enveloped body + HTTP status. */
export function storeWireErrorBody(error: VendoError): { status: number; body: StoreWireError } {
  return {
    status: STORE_WIRE_STATUS_BY_CODE[error.code],
    body: {
      error: {
        code: error.code,
        message: safeErrorMessage(error),
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    },
  };
}

/** How much of an unreadable body rides the message: enough to name the shape
    that arrived (a JSON key, an HTML title), short enough that a proxy's error
    page can never become the error message. */
const ERROR_BODY_SNIPPET = 200;

/** The body this parser could not read, bounded, for the message. A body thrown
    away here is the next protocol skew nobody can diagnose — field 2026-08-17:
    a console 409 carrying a schema proposal reached the caller as a bare
    "store wire request failed with HTTP 409" and the proposal was simply gone,
    so the live repro was the only way to learn what the server had said. */
function bodySnippet(body: unknown): string {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = (JSON.stringify(body) as string | undefined) ?? "";
    } catch {
      return "";
    }
  }
  if (text === "") return "";
  return ` — body: ${text.length > ERROR_BODY_SNIPPET ? `${text.slice(0, ERROR_BODY_SNIPPET)}…` : text}`;
}

/** Client half: a non-2xx response → VendoError. An enveloped wire-legal
    code wins over the bare status; a schema proposal is recognized as ITSELF,
    carrying the proposal on `detail` for the client that confirms it; recognized
    statuses map through STATUS_TO_CODE (429/5xx → "unavailable", retryable);
    anything else degrades to "not-implemented" — and says what it could not
    read, because a silently discarded body is an undiagnosable skew. */
export function parseStoreWireError(status: number, body: unknown): VendoError {
  const parsed = storeWireErrorSchema.safeParse(body);
  if (parsed.success) {
    return new VendoError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.detail as Json);
  }
  const proposed = storeWireSchemaProposalSchema.safeParse(body);
  if (proposed.success) {
    const { op, table } = proposed.data.proposal;
    return new VendoError(
      "schema-proposal",
      `the store proposed a schema change before this write: ${op} ${table}`,
      proposed.data.proposal as Json,
    );
  }
  return new VendoError(
    STATUS_TO_CODE[status] ?? "not-implemented",
    `store wire request failed with HTTP ${status}${bodySnippet(body)}`,
  );
}
