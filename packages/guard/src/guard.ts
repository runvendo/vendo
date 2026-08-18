import {
  type AppId,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  assertEngineCollection,
  type AtomicRecordStore,
  auditContext,
  type AuditEvent,
  buildGrant,
  canonicalJson,
  descriptorHash,
  emitUsage,
  type GrantId,
  grantRefs,
  type GrantScope,
  type GuardDecision,
  type IsoDateTime,
  isUnattended,
  type Json,
  log,
  type MintGrantInput,
  type PermissionGrant,
  presenceOnlyCall,
  type Principal,
  projectableForRun,
  type RecordInput,
  type RecordQuery,
  type RecordStore,
  type RunContext,
  serviceToolSlug,
  approvalRecordRefs,
  sha256Hex,
  type StoreAdapter,
  type StoreOps,
  type ToolCall,
  type ToolDescriptor,
  type ToolListingContext,
  type ToolOutcome,
  toolOutcomeSchema,
  type ToolRegistry,
  UNATTENDED_DESTRUCTIVE_REASON,
  isVendoError,
  VendoError,
  type VendoRecord,
  withheldFromUnattended,
  withResolvedRisk,
} from "@vendoai/core";
import { PolicyResolver, resolvePolicyConfig, ruleMatches } from "./policy.js";
import type {
  CreateGuardConfig,
  Judge,
  PolicyConfigObject,
  PolicyRule,
  VendoGuard,
} from "./types.js";

/** A BYO loop has no turn-driven abandonment sweep, so an orphaned approval
 *  card in a foreign chat expires on time instead: generous enough to walk away
 *  and come back, bounded enough that stale writes can't be approved days
 *  later. */
const DEFAULT_PARKED_CALL_TTL_MS = 60 * 60_000;

/** `0` (the documented off switch) and any other non-negative integer only —
 *  validated HERE so both entry points, `guard({ approvals })` and a direct
 *  `createGuard`, refuse the same typo the same way. */
function resolveParkedCallTtlMs(configured: number | undefined): number {
  const ttlMs = configured ?? DEFAULT_PARKED_CALL_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new VendoError(
      "validation",
      "guard approvals.parkedCallTtlMs must be a non-negative integer (0 disables parked-call expiry)",
    );
  }
  return ttlMs;
}

/** The breaker defaults (05 §2): 60 calls a minute per principal, 20 writes a run. */
const DEFAULT_MAX_CALLS_PER_MINUTE = 60;
const DEFAULT_MAX_WRITES_PER_RUN = 20;

/** Same rule and the same reason as {@link resolveParkedCallTtlMs}, now that
 *  `guard({ breakers })` is a host-facing door: a limit is a non-negative
 *  integer. `0` is legal and means everything asks — a coherent lockdown, since
 *  the comparisons are `writes >= max` and `active.length > max`. Both ends of
 *  the range otherwise fail SILENTLY and in opposite directions: a negative
 *  limit parks every call for the life of the process, while `NaN` and
 *  `Infinity` make both comparisons false, so the breaker never trips and the
 *  deterministic backstop is simply gone. `Number.isInteger` is false for all
 *  three, and for a fraction, which is a threshold nobody can act on. */
function resolveBreakerLimit(configured: number | undefined, name: string, fallback: number): number {
  const limit = configured ?? fallback;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new VendoError(
      "validation",
      `guard breakers.${name} must be a non-negative integer (0 makes every call ask)`,
    );
  }
  return limit;
}

const GRANTS_COLLECTION = "vendo_grants";
const APPROVALS_COLLECTION = "vendo_approvals";
/** One-time transition receipts for approvals: `decided:<id>` /
 *  `consumed:<id>` rows in a guard-owned generic collection, written only via
 *  the store's atomic `insertIfAbsent` (02-store §4) so exactly one caller —
 *  across processes — wins each transition. Rows carry `refs.subject`, so the
 *  02-store §5 erase cascade collects them with the rest of the subject's data.
 *
 *  KNOWN LIMIT — the receipt is the only atomic thing in the protocol. The
 *  `vendo_approvals` row itself has no CAS: the routed store exposes
 *  `RecordStore.atomic` (01-core §12) for `vendo_threads`, `vendo_apps` and
 *  generic rows only, so every marker written onto an approval — `consumedAt`,
 *  `voidedAt`, a decided status — is a `get` followed by a `put`, and something
 *  else can move the row in between. The receipt is what makes that survivable:
 *  the winner of a transition is decided BEFORE any row write, so the worst a
 *  lost race can do is leave a marker stale or (if an erase lands inside the
 *  window) let a re-put resurrect a row nobody can act on — the transition it
 *  would need is already spent, so no call ever executes off it. Closing the
 *  window properly needs guarded writes on `vendo_approvals`; not chased here. */
const APPROVAL_CLAIMS_COLLECTION = "guard:approval-claims";
const AUDIT_COLLECTION = "vendo_audit";
/** The emergency stop is a ROW (`freeze`, `{ frozen, by, at }`) and not a config
 *  field: the moment you need a kill switch is the moment you cannot redeploy to
 *  get one, so the console flips this row directly and a guard in another
 *  process obeys it on its next check. */
const CONTROLS_COLLECTION = "guard:controls";
const FREEZE_ROW = "freeze";
/** The block a frozen guard returns — the same words at the check and at the
 *  execute re-read, so the two agree. */
const FROZEN_REASON = "vendo is frozen — nothing runs until it is unfrozen";
/** How long a CHECK-TIME freeze answer may be reused (the execute gate never
 *  reuses one). A freeze flipped in another process therefore starts blocking
 *  new checks within this window, and blocks every DISPATCH immediately. */
const FROZEN_CACHE_MS = 10_000;
/** Build contract §7 — the effect ledger: one row per completed mutating call,
 *  keyed by (run, tool, exact input). It is what makes fail-and-re-run correct:
 *  a re-run of a run that already sent the payment must not send it again. */
const EFFECTS_COLLECTION = "vendo_effects";
const JUDGE_TIMEOUT_MS = 15_000;
/** How long a `previewCheck` verdict may still answer for the dispatch that
 *  follows it ({@link GuardImplementation.#decideForExecution}). A real
 *  preview→dispatch gap is a few milliseconds — this is three orders of
 *  magnitude of headroom for a loaded machine, and still far below any window in
 *  which a person, an admin or another call could plausibly change the answer.
 *  Expiry is fail-closed and costs only speed: the dispatch evaluates the full
 *  pipeline again, exactly as it did before verdicts were ever reused. */
const PREVIEW_TTL_MS = 5_000;
/** Build contract §9.10 — the one rank the org clamp compares on: an org rule
 *  may move a decision UP this order and never down. */
const strictness = (action: PolicyRule["action"]): number =>
  action === "block" ? 2 : action === "ask" ? 1 : 0;

interface ApprovalRecordData {
  request: ApprovalRequest;
  status: "pending" | "approved" | "denied";
  decidedAt?: IsoDateTime;
  sessionId: string;
  consumedAt?: IsoDateTime;
  /** WHO decided, and it is only ever a standing answer when it was a person.
   *  Every denial converges on the same row — a real "no", the chat turn the
   *  user walked away from, a BYO embed timing out, the 60-minute TTL sweep —
   *  and only the first of those is the user telling us something. Absent on
   *  rows written before this field existed, which read as `system`: the
   *  fail-safe direction is to ask again, never to enforce a no nobody said. */
  deniedBy?: "human" | "system";
  /** This decision no longer stands: the person took it back
   *  (`approvals.revoke`), or a newer human decision on the same call
   *  superseded it. A voided row is inert for replay and for standing denial,
   *  and is kept rather than deleted so the audit trail stays whole. */
  voidedAt?: IsoDateTime;
}

type DraftDecision =
  | {
      action: "run";
      decidedBy: Extract<GuardDecision, { action: "run" }>["decidedBy"];
      grantId?: GrantId;
    }
  | {
      action: "ask";
      decidedBy: Extract<GuardDecision, { action: "ask" }>["decidedBy"];
    }
  | {
      action: "block";
      reason: string;
      decidedBy: Extract<GuardDecision, { action: "block" }>["decidedBy"];
    };

interface DecisionMetadata {
  decision: DraftDecision;
  rationale?: string;
  invalidatedGrants?: PermissionGrant[];
}

interface CompletedDecision {
  decision: GuardDecision;
  descriptor: ToolDescriptor;
  rationale?: string;
}

interface AuditQueryFilter {
  principal?: Principal;
  appId?: AppId;
  kind?: AuditEvent["kind"];
  from?: IsoDateTime;
  to?: IsoDateTime;
  cursor?: string;
  limit?: number;
}

interface AuditExportFilter {
  from?: IsoDateTime;
  to?: IsoDateTime;
}

function now(): IsoDateTime {
  return new Date().toISOString();
}

function makeId(prefix: "grt_" | "apr_" | "aud_"): string {
  return `${prefix}${globalThis.crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJson<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function exactInputHash(args: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(args))}`;
}

/** Build contract §7's key: sha256 over the run, the tool, and the exact input.
 *  `undefined` means this call is not ledger-eligible at all.
 *
 *  The contract writes the preimage as `runId|turnId`. The run component is the
 *  FIRING (`ctx.trigger.lineageId`), falling back to the run itself. `ctx.turnId`
 *  now exists (§3.5) and is deliberately NOT used: a turn is even narrower than a
 *  session, so it fails for the reason the next paragraph gives, only harder.
 *
 *  It deliberately does NOT fall back to `ctx.sessionId`, even though the write
 *  breaker and `task`-duration grants do. The ledger exists to make
 *  fail-and-RE-RUN correct, and a re-run is a property of a run: an unattended
 *  run that failed halfway is retried with the same runId, which is exactly what
 *  must not double-charge. A chat session has no such identity — it spans many
 *  turns — so keying on it made "pay this invoice" asked twice in one
 *  conversation execute once and replay the first receipt. That was a real bug
 *  (caught by vendo's compound e2e), not a theoretical one.
 *
 *  Scoping is load-bearing in both directions: narrower (per call id) would never
 *  dedupe a re-run at all, and broader (per subject) would make a daily
 *  automation fire once and then never again.
 *
 *  The lineage is why: "fail loudly, then run it again" does not resume a run — it
 *  starts a fresh one of the same trigger on the same event — so a receipt written
 *  under the failed run's id was invisible to the very re-run it existed to
 *  protect, and work that had already landed happened twice. A ctx that names no
 *  lineage behaves exactly as before. */
function effectBaseKey(ctx: RunContext, call: ToolCall): string | undefined {
  const runId = ctx.trigger?.lineageId ?? ctx.trigger?.runId;
  if (runId === undefined) return undefined;
  return canonicalJson([runId, call.tool, exactInputHash(call.args)]);
}

/** Build contract §7 (amended 2026-07-30) — the key includes an ORDINAL counting
 *  prior identical calls in the same run.
 *
 *  Without it, "pay $10 twice" — two deliberate, separately-authorized calls with
 *  identical arguments — collapsed into one payment while both reported success.
 *  The ordinal is assigned per CALL ID, so the two intents get 0 and 1 and both
 *  execute, while a genuine re-run of an already-completed call reuses its own
 *  ordinal and is still deduped. That is the whole distinction the ledger has to
 *  draw: same intent repeated, versus one intent retried. */
function effectKeyOf(base: string, ordinal: number): string {
  return `sha256:${sha256Hex(canonicalJson([base, ordinal]))}`;
}

function inputPreview(call: ToolCall): string {
  const preview = `${call.tool} ${canonicalJson(call.args)}`;
  return preview.length > 500 ? `${preview.slice(0, 499)}…` : preview;
}

function eventFromContext(
  ctx: RunContext,
  fields: Omit<AuditEvent, "id" | "at" | "principal" | "venue" | "presence" | "appId" | "trigger" | "clientId">,
): AuditEvent {
  return {
    id: makeId("aud_"),
    at: now(),
    // Core's `auditContext` — the one copy of the ctx half. This mint used to own
    // the only correct spelling of it, which is exactly why the five rows that do
    // not come through here each drifted when `turnId` was added.
    ...auditContext(ctx),
    ...fields,
  };
}

/** The seven verbs every drawer in this block is reached through. */
type EngineOps = StoreOps["engine"];

/** `ops.engine` over a bare {@link StoreAdapter}, for the deployment whose
 *  composition could not resolve a 42-op surface (`selectStoreOps` answers
 *  `undefined` for a store with neither its own ops nor a SQL handle) and for
 *  every host passing their own adapter. Verb for verb the local backend's
 *  family (packages/store/src/ops.ts): the allowlist gate in front, the routed
 *  door behind, and `not-implemented` where a door omits an optional
 *  capability — so single-use approval transitions fail closed here exactly as
 *  they do on the hosted wire.
 *
 *  `records()` is called per verb and never cached: an adapter is free to mint
 *  a fresh handle each time, and the fixtures that wrap one to inject a failure
 *  depend on it. */
function adapterEngine(store: StoreAdapter): EngineOps {
  const door = (collection: string): RecordStore => {
    assertEngineCollection(collection);
    return store.records(collection);
  };
  const atomic = (collection: string, verb: string): AtomicRecordStore => {
    const capability = door(collection).atomic;
    if (capability === undefined) {
      throw new VendoError(
        "not-implemented",
        `${collection} does not support ${verb}: this adapter omits the optional `
        + "atomic-revisions capability (RecordStore.atomic, 02-store §4)",
      );
    }
    return capability;
  };
  return {
    get: async (collection, id) => await door(collection).get(id),
    put: async (collection, record) => await door(collection).put(record),
    delete: async (collection, id) => {
      await door(collection).delete(id);
    },
    list: async (collection, query) => await door(collection).list(query),
    claim: async (collection, expected, replacement) => {
      const claim = door(collection).claim;
      if (claim === undefined) {
        throw new VendoError("not-implemented", `${collection} does not support claim`);
      }
      return await claim(expected, replacement);
    },
    insertIfAbsent: async (collection, record) =>
      await atomic(collection, "insertIfAbsent").insertIfAbsent(record),
    compareAndSwap: async (collection, record, expectedRevision) =>
      await atomic(collection, "compareAndSwap").compareAndSwap(record, expectedRevision),
  };
}

async function listAll(
  engine: EngineOps,
  collection: string,
  query: Omit<RecordQuery, "cursor"> = {},
): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await engine.list(collection, { ...query, ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);

  return records;
}

function approvalData(record: VendoRecord): ApprovalRecordData {
  return record.data as ApprovalRecordData;
}

function grantData(record: VendoRecord): PermissionGrant {
  return record.data as PermissionGrant;
}

function auditData(record: VendoRecord): AuditEvent {
  return record.data as AuditEvent;
}

function scopeMatches(scope: GrantScope, call: ToolCall): boolean {
  if (scope.kind === "tool") return true;
  // A `service-tool` grant is authority over ONE service action, whatever
  // arguments it is called with — the connector dispatcher's tool name says
  // nothing about what the call does, so the slug is the thing consented to.
  if (scope.kind === "service-tool") return scope.slug === serviceToolSlug(call);
  return scope.inputHash === exactInputHash(call.args);
}

function durationMatches(grant: PermissionGrant, ctx: RunContext): boolean {
  if (grant.duration === "standing") return true;
  if (grant.duration === "session") return grant.contextKey === ctx.sessionId;
  return grant.contextKey === (ctx.trigger?.runId ?? ctx.sessionId);
}

function presenceMatches(grant: PermissionGrant, ctx: RunContext): boolean {
  if (ctx.presence === "away") {
    // The binding comes from WHICH IDENTITY THE CTX CARRIES, and the two arms are
    // MUTUALLY EXCLUSIVE — the discriminator is the TRIGGER, because that is what
    // makes a run an automation firing at all.
    //
    // A FIRING (it carries a trigger) is one record, consented to on its own — the
    // person arming it was shown that record's task — and a record carries no app
    // reference, so the automation id is the WHOLE match and a grant naming none
    // rides nothing away. Keying this arm on `trigger.automationId` instead of on
    // the trigger's mere presence would let a firing that carries an appId but no
    // automation id fall through to the app arm and ride an app-bound yes
    // (mint-grant.test.ts:118-130) — one app's yes riding every automation in it.
    //
    // NO trigger at all means it is nobody's firing: a boxed ("machine", layer-2)
    // app callback, which `wire/box.ts:311-317` mints as
    // `{ venue: "app", presence: "away", appId }`. It has only the app it runs as,
    // so the app is the whole match — main's away rule for this venue.
    if (grant.source !== "automation") return false;
    if (ctx.trigger !== undefined) {
      return grant.automationId !== undefined && grant.automationId === ctx.trigger.automationId;
    }
    return grant.appId !== undefined && grant.appId === ctx.appId;
  }
  return grant.appId === undefined || grant.appId === ctx.appId;
}

/** A read invoked from the APP venue renders a
 *  surface — the query resolver and island tool bridge consume the outcome at
 *  render time, and a parked read query is never resumed (apps resume only
 *  mutating actions). An "ask" on a present app-venue read is therefore a
 *  permanently empty region plus a dead approval card, so the HEURISTIC
 *  deciders (judge, call-rate breaker) may run or block such a read but never
 *  park it. Deliberate postures are exempt and keep their ask: policy rules
 *  and host policy code are host-authored, confirmEach descriptors always ask
 *  (05 §2), and away runs still park (the 05 §6 downgrade needs a captured
 *  grant regardless of what decided the run — hence the present-only scope). */
function neverParkAppRead(descriptor: ToolDescriptor, ctx: RunContext): boolean {
  return descriptor.risk === "read" && ctx.venue === "app" && ctx.presence === "present";
}

/** What makes a previewed verdict answer for THIS dispatch and nothing else
 *  ({@link GuardImplementation.previewCheck}). Everything the verdict was
 *  computed from that a caller could vary is pinned: another subject, another
 *  venue/presence/app, other arguments, or a re-graded descriptor all miss and
 *  are evaluated fresh. */
function previewKey(call: ToolCall, descriptor: ToolDescriptor, ctx: RunContext): string {
  return [
    call.id, call.tool, exactInputHash(call.args), descriptorHash(descriptor),
    ctx.principal.subject, ctx.venue, ctx.presence, ctx.appId ?? "",
    ctx.trigger?.runId ?? ctx.sessionId,
  ].join("\n");
}

/** Every write of an approval row derives its refs here, so the index can
 *  never drift from the data. `call` is what keeps the standing-denial lookup
 *  off a subject's whole approval history: chat's random ids simply miss it. */
function approvalRefs(data: ApprovalRecordData): Record<string, string> {
  // Core owns the projection: the automations arming capture writes the same
  // collection, and two writers spelling the refs by hand is how one of them
  // minted rows the pending feed could not see (approvalRecordRefs).
  return approvalRecordRefs(data.request, data.status);
}

/** The identity a parked approval answers for: the exact call the user saw, in
 *  exactly the context they saw it. Beyond subject + call identity this pins
 *  (a) the inputs — a replay with tampered args never rides the decision — (b)
 *  the frozen descriptor — flipping the same tool from read to destructive
 *  after parking can't ride it either — and (c) the parked venue/presence/app,
 *  so a present chat decision can't answer an away, app-bound automation call.
 *  Shared by the approved-replay, standing-denial and supersede lookups so a
 *  yes and a no can never come to mean different calls. */
function sameParkedCall(
  request: ApprovalRequest,
  call: ToolCall,
  // The parked shape, not the live one, so a stored decision can be matched
  // against another stored decision (the supersede lookup) with no cast.
  ctx: ApprovalRequest["ctx"],
  descriptorFingerprint: string,
): boolean {
  return request.ctx.principal.subject === ctx.principal.subject
    && request.call.id === call.id
    && request.call.tool === call.tool
    && exactInputHash(request.call.args) === exactInputHash(call.args)
    && descriptorHash(request.descriptor) === descriptorFingerprint
    && request.ctx.venue === ctx.venue
    && request.ctx.presence === ctx.presence
    && request.ctx.appId === ctx.appId;
}

function normalizeCodeDecision(decision: GuardDecision): DraftDecision {
  // The policy-code stage cannot self-attribute its provenance. `policy.code` is
  // deploy-time host code, not the user's real-time consent, so it must never be
  // able to return `decidedBy: "grant"` — that label is reserved for an actual
  // app-bound PermissionGrant and is the ONLY "run" the away-downgrade gate
  // (05 §6) exempts from parking. Forcing every code decision to "rule" (and
  // dropping any code-supplied grantId) makes a code-sourced run behave exactly
  // like a rule-sourced run: away-downgraded to a park, and honestly attributed
  // in the audit trail. This mirrors how code ERRORS already fail to "rule".
  if (decision.action === "block") {
    return { action: "block", reason: decision.reason, decidedBy: "rule" };
  }
  return { action: decision.action, decidedBy: "rule" };
}

function normalizeRememberedScope(scope: GrantScope, request: ApprovalRequest): GrantScope {
  if (scope.kind !== "exact") return cloneJson(scope);
  // Always derive exact scopes from the approved request itself: honoring a
  // caller-supplied inputHash/inputPreview would let a wire caller mint a grant
  // whose preview lies about what it authorizes (the one-security-rule says the
  // user approved THESE inputs, so the grant is bound to exactly these inputs).
  return {
    kind: "exact",
    inputHash: exactInputHash(request.call.args),
    inputPreview: inputPreview(request.call),
  };
}

class GuardImplementation implements VendoGuard {
  readonly #engine: EngineOps;
  /** Per (run, tool, exact input): which ordinal each CALL ID was assigned.
   *  Keyed by call id so a replay of one call reuses its ordinal (and dedupes)
   *  while a second, separately-intended identical call gets the next one. */
  readonly #effectOrdinals = new Map<string, Map<string, number>>();
  /** In-flight execution per effect key, so concurrent identical calls share one
   *  execution instead of both racing past an empty ledger. */
  readonly #effectsInFlight = new Map<string, Promise<ToolOutcome>>();
  /** The verdict `previewCheck` computed, held for the ONE dispatch that
   *  follows it (see {@link #decideForExecution}). Single-use, key-pinned, and
   *  swept with the breaker maps for a preview no dispatch ever collected. */
  readonly #previewed = new Map<
    string,
    { at: number; subject: string; completed: CompletedDecision }
  >();
  readonly #config: CreateGuardConfig;
  readonly #policyConfig: PolicyConfigObject | undefined;
  readonly #policy: PolicyResolver;
  readonly #maxCallsPerMinute: number;
  readonly #maxWritesPerRun: number;
  readonly #callWindows = new Map<string, number[]>();
  readonly #writeCounts = new Map<string, { count: number; touchedAt: number }>();
  #lastSweepAt = 0;
  /** The last freeze answer a fresh read produced (see {@link frozen}). */
  #frozenCache: { at: number; value: boolean } | undefined;
  readonly #approvalCallbacks = new Set<(id: ApprovalId, approved: boolean) => void>();
  readonly #approvalRequestedCallbacks = new Set<(request: ApprovalRequest) => void>();

  readonly approvals = {
    parkedCallTtlMs: DEFAULT_PARKED_CALL_TTL_MS,
    pending: (principal: Principal): Promise<ApprovalRequest[]> =>
      this.#pendingApprovals(principal),
    decide: (
      ids: ApprovalId | ApprovalId[],
      decision: ApprovalDecision,
      principal: Principal,
    ): Promise<void> => this.#decideApprovals(ids, decision, principal, "human"),
    revoke: (id: ApprovalId, principal: Principal): Promise<void> =>
      this.#revokeApproval(id, principal),
  };

  readonly grants = {
    list: (principal: Principal): Promise<PermissionGrant[]> => this.#listGrants(principal),
    revoke: (id: GrantId, principal: Principal): Promise<void> =>
      this.#revokeGrant(id, principal),
  };

  readonly audit = {
    query: (filter: AuditQueryFilter): Promise<{ events: AuditEvent[]; cursor?: string }> =>
      this.#queryAudit(filter),
    export: (filter?: AuditExportFilter): AsyncIterable<string> => this.#exportAudit(filter),
  };

  constructor(config: CreateGuardConfig) {
    this.#engine = config.ops?.engine ?? adapterEngine(config.store);
    this.#config = config;
    // Compose time, not first call: an unknown preset name (or any other
    // policy misconfiguration `resolvePolicyConfig` catches) must fail loud
    // from `createGuard` itself.
    this.#policyConfig = resolvePolicyConfig(config.policy);
    this.#policy = new PolicyResolver(this.#policyConfig);
    this.#maxCallsPerMinute = resolveBreakerLimit(
      config.breakers?.maxCallsPerMinute, "maxCallsPerMinute", DEFAULT_MAX_CALLS_PER_MINUTE,
    );
    this.#maxWritesPerRun = resolveBreakerLimit(
      config.breakers?.maxWritesPerRun, "maxWritesPerRun", DEFAULT_MAX_WRITES_PER_RUN,
    );
    this.approvals.parkedCallTtlMs = resolveParkedCallTtlMs(config.approvals?.parkedCallTtlMs);
  }

  async check(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<GuardDecision> {
    return (await this.#checkWithMetadata(call, descriptor, ctx)).decision;
  }

  /** A preview of `check()`'s verdict for a caller that is
   *  about to make (or ask the SDK to make) the REAL, dispatching call
   *  itself: a "run" verdict here never spends the write-budget/call-rate
   *  breakers, because the caller's own follow-up (calling `check()` again,
   *  or executing through a guard-bound registry) will spend it for real
   *  moments later. An "ask"/"block" verdict is unaffected — it parks/audits
   *  exactly as `check()` does, because for those outcomes THIS is the only
   *  evaluation that ever runs. Optional on `VendoGuard` (feature-detected,
   *  packages/agent tools.ts): a guard that omits it falls back to plain
   *  `check()`, restoring the double-count this exists to avoid rather than
   *  breaking a caller that only implements the base `Guard` interface. */
  async previewCheck(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<GuardDecision> {
    const completed = await this.#checkWithMetadata(call, descriptor, ctx, false);
    // Handed to the dispatch that follows, so one logical call evaluates rules,
    // grants, the org layer and the judge ONCE instead of twice (#decideForExecution
    // spends there what this pass deliberately did not). An "ask" is never handed
    // on: the caller waits for a person, and the tap that answers them IS the
    // fresh verdict the dispatch must read.
    if (completed.decision.action !== "ask") {
      // Swept where it GROWS: a process that only ever previews (every call
      // ruled out downstream, never dispatched) reaches no other sweep site.
      this.#sweepBreakerState(Date.now());
      this.#previewed.set(previewKey(call, descriptor, ctx), {
        at: Date.now(),
        subject: ctx.principal.subject,
        completed,
      });
    }
    return completed.decision;
  }

  async report(event: AuditEvent): Promise<void> {
    await this.reportThrough(event, (collection, record) => this.#engine.put(collection, record));
  }

  /** `report`, with the audit row handed to `place` instead of written to this
   *  guard's own engine — the seam a batched turn folds its ONE run row
   *  through, so the row rides the same call as the messages it describes.
   *
   *  This IS `report`: every rule above applies, because `report` is this with
   *  the engine as the placer. It exists for the TURN row and nothing else —
   *  a per-tool-call decision has no batch to ride and keeps writing one row
   *  per call, which is the guarantee that makes the audit trail worth having.
   */
  async reportThrough(
    event: AuditEvent,
    place: (collection: string, record: RecordInput) => Promise<unknown>,
  ): Promise<void> {
    const normalized: AuditEvent = {
      ...event,
      id: event.id || makeId("aud_"),
      at: event.at || now(),
    };
    // Beside the audit row, never instead of it, and it decides nothing: the
    // SHAPE of the decision (which kind, how it came out, on which tool) for
    // whoever is counting. Reported here rather than at each of the ten mint
    // sites because this is the one door every row already passes through, and
    // before the write because the decision stands whether or not the row lands.
    // Never a principal, never an input preview.
    emitUsage({
      name: "guard_decision",
      kind: normalized.kind,
      decision: normalized.outcome ?? normalized.decidedBy ?? "none",
      tool: normalized.tool ?? null,
    });
    const refs: Record<string, string> = {
      subject: normalized.principal.subject,
      kind: normalized.kind,
    };
    if (normalized.appId !== undefined) refs.app_id = normalized.appId;
    if (normalized.tool !== undefined) refs.tool = normalized.tool;
    await place(AUDIT_COLLECTION, {
      id: normalized.id,
      data: normalized,
      refs,
    });
  }

  async directions(_ctx: RunContext): Promise<string[]> {
    return this.#policy.directions();
  }

  onApprovalDecision(cb: (id: ApprovalId, approved: boolean) => void): () => void {
    this.#approvalCallbacks.add(cb);
    return () => {
      this.#approvalCallbacks.delete(cb);
    };
  }

  onApprovalRequested(cb: (request: ApprovalRequest) => void): () => void {
    this.#approvalRequestedCallbacks.add(cb);
    return () => {
      this.#approvalRequestedCallbacks.delete(cb);
    };
  }

  /** Deny approvals the conversation abandoned. Rides the same
   *  decide path as an explicit denial (audit + callbacks), but is
   *  idempotent: an already-decided (conflict) or unknown/foreign (not-found)
   *  approval already holds the state abandonment wants — only a real store
   *  failure propagates. */
  async abandonApprovals(ids: ApprovalId[], ctx: RunContext): Promise<void> {
    for (const id of ids) {
      try {
        await this.#decideApprovals(id, { approve: false }, ctx.principal, "system");
      } catch (error) {
        if (isVendoError(error) && (error.code === "conflict" || error.code === "not-found")) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Spends an approval's single use for a caller that will NOT replay its call:
   * the automations engine turns one yes into the app-bound standing grant its
   * consent moment asked for (07 §3) instead of re-dispatching it. That spend
   * claims the very same `consumed:<id>` transition a replay and a take-back
   * claim, so a revoke landing at the same instant can never lose to a grant
   * mint. Owner-scoped, and unknown/foreign/undecided ids all read as
   * `already-spent` — this is a subscriber's fast path, not a place to learn
   * whether someone else's approval exists.
   */
  async spendApproval(
    id: ApprovalId,
    principal: Principal,
  ): Promise<"spent" | "already-spent" | "taken-back"> {
    const record = await this.#engine.get(APPROVALS_COLLECTION, id);
    if (record === null) return "already-spent";
    const data = approvalData(record);
    if (data.request.ctx.principal.subject !== principal.subject) return "already-spent";
    if (data.status !== "approved" || data.consumedAt !== undefined) return "already-spent";
    if (data.voidedAt !== undefined) return "taken-back";
    return await this.#spendConsumedTransition(id, principal.subject);
  }

  /** The ONE mint. Every remembered yes — this guard's own decide path below,
   *  and the automations engine's consent moment through core's `Guard` seam —
   *  becomes a row here, so the grant and its listing refs cannot be spelled
   *  two ways by two writers. */
  async mintGrant(input: MintGrantInput): Promise<GrantId> {
    const grant = buildGrant(input, makeId("grt_"), now());
    await this.#engine.put(GRANTS_COLLECTION, { id: grant.id, data: grant, refs: grantRefs(grant) });
    return grant.id;
  }

  /** The TTL backstop over the general approvals
   *  collection. Chat approvals are abandoned on the next thread turn and BYO
   *  parked calls have their own sweep, but away/automation/app approvals — and
   *  approvals from turns that errored mid-stream before their thread part
   *  persisted — have no resuming turn and would sit pending forever. This
   *  denies every pending approval older than `ttlMs`, across ALL subjects
   *  (each abandoned as its OWN principal, so tenant isolation holds), through
   *  the same idempotent deny path as abandonment. Returns the count actually
   *  swept. A `ttlMs <= 0` disables the sweep. */
  async sweepExpiredApprovals(ttlMs: number, at: number = Date.parse(now())): Promise<number> {
    if (ttlMs <= 0) return 0;
    // Filtered by the store, not in JS: this runs every 60s for the life of the
    // process, and the unfiltered read grows with every approval ever decided.
    const records = await listAll(this.#engine, APPROVALS_COLLECTION, {
      refs: { status: "pending" },
    });
    let swept = 0;
    for (const record of records) {
      const data = approvalData(record);
      const parkedAt = Date.parse(data.request.createdAt);
      if (!Number.isFinite(parkedAt) || parkedAt + ttlMs > at) continue;
      try {
        // Deny as the approval's OWN principal — a foreign subject would 404.
        await this.#decideApprovals(record.id, { approve: false }, data.request.ctx.principal, "system");
        swept += 1;
      } catch (error) {
        // Already decided (conflict) or gone (not-found): the queue already
        // holds the state the sweep wants — count nothing, never throw.
        if (isVendoError(error) && (error.code === "conflict" || error.code === "not-found")) {
          continue;
        }
        throw error;
      }
    }
    return swept;
  }

  bind(tools: ToolRegistry): ToolRegistry {
    return {
      // THE LAW (design §12), primary mechanism: a destructive or external tool
      // is NOT PROJECTED into an unattended run at all. A tool the model cannot
      // see is one it cannot be talked into using; a tool it can see but is
      // refused becomes something it retries and works around. Callers that pass
      // no context get the full set, exactly as before.
      // The context is forwarded INWARD as well as read here: the registry
      // narrows a lazily expanded connector toolkit to the listing that searched
      // it, so answering from the unscoped set would hand every reader another
      // conversation's expansion.
      descriptors: async (ctx?: ToolListingContext) => {
        const all = await tools.descriptors(ctx);
        return ctx === undefined ? all : projectableForRun(all, ctx);
      },
      execute: async (call, ctx) => {
        const descriptors = await tools.descriptors();
        const descriptor = descriptors.find((candidate) => candidate.name === call.tool);
        const preview = inputPreview(call);

        if (!descriptor) {
          const outcome: ToolOutcome = {
            status: "error",
            error: { code: "not-found", message: `Tool ${call.tool} was not found` },
          };
          await this.report(
            eventFromContext(ctx, {
              kind: "tool-call",
              tool: call.tool,
              inputPreview: preview,
              outcome: outcome.status,
            }),
          );
          return outcome;
        }

        const completed = await this.#decideForExecution(call, descriptor, ctx);
        const { decision } = completed;
        let outcome: ToolOutcome;

        // THE LAW (design §12), defence in depth. `projectableForRun` above is
        // the primary mechanism; this refuses whatever still got through.
        //
        // It sits AFTER the pipeline, not before, because two outcomes the law
        // explicitly wants must survive it:
        //  - `ask` parks the call and shows a person the real arguments. That IS
        //    the law's replacement pattern — the automation prepares, the human
        //    sends. Refusing ahead of the pipeline would delete it.
        //  - an approved REPLAY (run/"grant" with no grantId — see
        //    #grantForExecution) means a human already tapped this exact call
        //    with these exact arguments. That is attended irreversibility, which
        //    is precisely what the law asks for.
        // What it does refuse is a standing grant, rule, judge, or default
        // authorizing an irreversible action with nobody watching. No limit and
        // no override reaches past this.
        const replayApproved = decision.action === "run"
          && decision.decidedBy === "grant" && decision.grantId === undefined;
        // `withheldFromUnattended`, not `=== "destructive"`: an `ungraded` tool
        // is refused here too. The two laws land on the same answer — §12 keeps
        // irreversible actions off an unattended run, and the risk-grading
        // redesign says a tool nobody has graded needs a PERSON — and an
        // unattended venue has none to ask. Without this the merge left a real
        // hole: extraction stopped guessing from names, so Maple's
        // `host_transferMoney` reads `ungraded`, the vote that used to call it
        // destructive no longer speaks for it, and an enable-time standing grant
        // authorized an unattended transfer. Proved by the away drill: the run
        // came back `ok` and the money moved.
        //
        // Park-and-resume survives, which is what makes this a gate and not a
        // wall: an UNGRANTED ungraded step still parks (`ask` never reaches
        // here), and the approved replay that follows is exempt above. What
        // cannot happen any more is a standing grant silently running an
        // unjudged tool with nobody watching.
        //
        // `presenceOnlyCall` is the second layer of the OTHER half of the law.
        // `projectableForRun` hides the placement tools from an unattended
        // listing, but a projection only decides what the model is offered: a
        // standing automation grant, a resumed step, or a harness that calls
        // without listing reaches `execute()` by name regardless. Those tools
        // are honestly `write`, so the risk-keyed test above never spoke for
        // them and the projection was their whole law.
        //
        // It refuses the PIN tools and nothing else. `vendo_make` carrying a
        // `slot` is not refused here: creation does not need
        // a person present, only placement does, and blocking the call would
        // break every automation that legitimately builds a screen. The slot is
        // dropped at the tool's own door instead (`apps/agent-tools.ts`).
        if (
          decision.action === "run" && !replayApproved && isUnattended(ctx)
          && (withheldFromUnattended(completed.descriptor) || presenceOnlyCall(call))
        ) {
          const refused: ToolOutcome = { status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON };
          await this.report(
            eventFromContext(ctx, {
              kind: "policy-decision",
              tool: call.tool,
              risk: completed.descriptor.risk,
              inputPreview: preview,
              outcome: refused.status,
              decidedBy: "rule",
              detail: {
                reason: "unattended-destructive",
                declaredRisk: completed.descriptor.risk,
              },
            }),
          );
          return refused;
        }

        if (decision.action === "block") {
          // A frozen block already audited itself best-effort inside the check.
          // Return it here rather than fall through to the generic tool-call
          // audit below: that write also targets vendo_audit, and an audit that
          // is momentarily down must never turn the freeze into an error.
          if (decision.decidedBy === "frozen") {
            return { status: "blocked", reason: decision.reason };
          }
          outcome = { status: "blocked", reason: decision.reason };
        } else if (decision.action === "ask") {
          outcome = {
            status: "pending-approval",
            approvalId: decision.approval.id,
          };
        } else {
          // Kill-switch re-read (freeze check-to-execute gap): #checkWithMetadata
          // read the freeze row at the TOP, before the grants/judge pipeline's
          // awaits (the judge alone can run up to 15s). A freeze that lands during
          // that window — or between the check returning "run" and this dispatch —
          // leaves a stale "run" that would otherwise touch the registry. Re-read
          // here, immediately before running the tool, so a frozen guard can never
          // execute, even off a check that predated the freeze. Best-effort audit
          // (an audit failure must not turn the freeze into an error).
          if (await this.frozen()) {
            await this.#reportFrozenBlock(ctx, call);
            return { status: "blocked", reason: FROZEN_REASON };
          }
          outcome = await this.#runOnce(tools, call, decision, completed.descriptor, ctx);
        }

        const detail: Record<string, unknown> = {};
        if (decision.decidedBy === "judge" && completed.rationale !== undefined) {
          detail.rationale = completed.rationale;
        }
        if (decision.action === "run" && decision.grantId !== undefined) {
          detail.grantId = decision.grantId;
        }
        // Cross-cutting audit enrichment (block-actions design): a connector
        // attaches its account identity to the outcome as the passthrough
        // `connectorAccount`, and the actAs seam attaches its disposition as
        // `actAs` (minted | declined | mismatch | error — "declined" is the
        // away re-verification failing closed). Both belong to the audit
        // trail, not to the model or the UI, so lift them into detail and
        // strip them from the outcome.
        const { connectorAccount, actAs, ...cleaned } =
          outcome as ToolOutcome & { connectorAccount?: unknown; actAs?: unknown };
        if (connectorAccount !== undefined) detail.connectorAccount = connectorAccount;
        if (actAs !== undefined) detail.actAs = actAs;
        if (connectorAccount !== undefined || actAs !== undefined) {
          outcome = cleaned as ToolOutcome;
        }
        await this.report(
          eventFromContext(ctx, {
            kind: "tool-call",
            tool: call.tool,
            risk: completed.descriptor.risk,
            inputPreview: preview,
            outcome: outcome.status,
            decidedBy: decision.decidedBy,
            ...(Object.keys(detail).length === 0 ? {} : { detail }),
          }),
        );
        return outcome;
      },
    };
  }

  async freeze(by: string): Promise<void> {
    await this.#setFrozen(true, by);
  }

  async unfreeze(by: string): Promise<void> {
    await this.#setFrozen(false, by);
  }

  /** Reads the flag row every time, unless the caller says a slightly stale
   *  answer will do (`cached`). Only the CHECK-TIME read does: it is one static
   *  row, read on every tool call, and the gate immediately before dispatch
   *  (`bind().execute`) is uncached — so the freeze a cached check missed still
   *  cannot reach a tool. Every fresh read refreshes the cached value, this
   *  guard's own freeze()/unfreeze() included, so an in-process flip is visible
   *  at once and only another process's flip can be up to
   *  {@link FROZEN_CACHE_MS} stale. */
  async frozen(opts?: { cached?: boolean }): Promise<boolean> {
    if (
      opts?.cached === true && this.#frozenCache !== undefined
      && Date.now() - this.#frozenCache.at < FROZEN_CACHE_MS
    ) {
      return this.#frozenCache.value;
    }
    let record: VendoRecord | null;
    try {
      record = await this.#engine.get(CONTROLS_COLLECTION, FREEZE_ROW);
    } catch (error) {
      // The kill switch could not even be READ (a store error). Fail CLOSED
      // and contain the failure into a decision, exactly as every other error
      // in the pipeline is contained — never let it escape check()/execute() as
      // an unhandled rejection while the guard silently stops gating.
      await this.#reportUnreadableControl(errorMessage(error));
      return this.#rememberFrozen(true);
    }
    // Absent row: the switch was never pulled — normal, unfrozen.
    if (record === null) return this.#rememberFrozen(false);
    const frozen = (record.data as { frozen?: unknown }).frozen;
    if (typeof frozen === "boolean") return this.#rememberFrozen(frozen);
    // A control row that EXISTS but does not parse is a kill switch we can no
    // longer read. Fail CLOSED — treat it as frozen — rather than let a corrupt
    // switch read as "run everything".
    await this.#reportUnreadableControl();
    return this.#rememberFrozen(true);
  }

  /** What the next check-time read may answer with. Fail-closed answers are
   *  cached like any other: the safe direction stays safe for at most a TTL. */
  #rememberFrozen(value: boolean): boolean {
    this.#frozenCache = { at: Date.now(), value };
    return value;
  }

  /** The kill switch could not be read as a boolean — the row is corrupt, or
   *  the store read itself threw. Either way the guard fails CLOSED; this leaves
   *  a note saying why, best-effort, because an audit-write failure must not
   *  turn a contained block back into an escaping exception. */
  async #reportUnreadableControl(error?: string): Promise<void> {
    try {
      await this.report({
        id: makeId("aud_"),
        at: now(),
        kind: "policy-decision",
        principal: { kind: "org", subject: "system" },
        venue: "chat",
        presence: "present",
        outcome: "blocked",
        decidedBy: "frozen",
        detail: {
          reason: "frozen",
          malformedControlRow: true,
          ...(error === undefined ? {} : { error }),
        },
      });
    } catch (reportError) {
      log({
        code: "guard.control-unreadable",
        level: "error",
        message: `[vendo] guard: the freeze control row is unreadable and the malformed-control audit note `
          + `could not be written (${errorMessage(reportError)}). The guard is failing closed.`,
      });
    }
  }

  /** Audit a frozen-path block, best-effort. The block itself is already the
   *  decision; a `vendo_audit` write failure here must never propagate and turn
   *  the freeze into an error — swallow it (with a note) and let the caller
   *  return the block. */
  async #reportFrozenBlock(ctx: RunContext, call: ToolCall): Promise<void> {
    try {
      await this.report(
        eventFromContext(ctx, {
          kind: "policy-decision",
          tool: call.tool,
          inputPreview: inputPreview(call),
          outcome: "blocked",
          decidedBy: "frozen",
        }),
      );
    } catch (error) {
      log({
        code: "guard.frozen-block-unaudited",
        level: "error",
        message: `[vendo] guard: ${call.tool} was blocked by the freeze, but the audit row could not be `
          + `written (${errorMessage(error)}). The block still stands.`,
      });
    }
  }

  /** The switch is flipped BEFORE it is reported: an audit failure must never
   *  leave the caller believing a freeze did not land. */
  async #setFrozen(frozen: boolean, by: string): Promise<void> {
    await this.#engine.put(CONTROLS_COLLECTION, {
      id: FREEZE_ROW,
      data: { frozen, by, at: now() },
    });
    this.#rememberFrozen(frozen);
    await this.report({
      id: makeId("aud_"),
      at: now(),
      kind: "policy-decision",
      principal: { kind: "user", subject: by },
      venue: "chat",
      presence: "present",
      decidedBy: "frozen",
      detail: { reason: frozen ? "frozen" : "unfrozen" },
    });
  }

  status(): { posture: "unconfigured" | "rules" | "judge" | "rules+judge" } {
    const hasRules = this.#policyConfig !== undefined;
    const hasJudge = this.#config.judge !== undefined;
    if (hasRules && hasJudge) return { posture: "rules+judge" };
    if (hasRules) return { posture: "rules" };
    if (hasJudge) return { posture: "judge" };
    return { posture: "unconfigured" };
  }

  /**
   * The verdict this dispatch runs on: the one `previewCheck` computed for
   * exactly this call moments ago, or a fresh evaluation when there is none.
   *
   * The preview was the WHOLE evaluation — rules, grants, org layer, judge — it
   * simply spent nothing, so a second pass answered the same question at the
   * cost of another judge run and another pair of store reads. What the preview
   * could not do is commit, and `#commitPreviewed` does that here; when it
   * cannot (a breaker filled up, or the human's single yes went elsewhere) the
   * verdict is thrown away and the pipeline decides again from scratch.
   *
   * What reuse deliberately does NOT skip: the kill switch, the breakers, the
   * org-admin layer, the live risk GRADE, and the authority the call runs on —
   * all re-read in `#commitPreviewed`, because each one can stop a call the
   * preview cleared. Nor does it answer at all past {@link PREVIEW_TTL_MS}: a
   * verdict is for the dispatch moments behind it, and an older entry falls
   * through to the full pipeline rather than speaking for a call it can no
   * longer describe.
   */
  async #decideForExecution(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<CompletedDecision> {
    const key = previewKey(call, descriptor, ctx);
    const previewed = this.#previewed.get(key);
    this.#previewed.delete(key);
    const committed = previewed === undefined || Date.now() - previewed.at > PREVIEW_TTL_MS
      ? undefined
      : await this.#commitPreviewed(previewed.completed, call, descriptor, ctx);
    return committed ?? await this.#checkWithMetadata(call, descriptor, ctx);
  }

  /** Spend what the preview left unspent, and re-ask everything that can have
   *  changed the answer since — or invalidated the spend. `undefined` means this
   *  verdict can no longer be committed and the caller must decide again.
   *
   *  Order is the contract here: every gate that can stop the call is read
   *  BEFORE anything is spent, so a call that does not proceed never costs the
   *  human's single-use yes, a write from the run's budget, or a slot in the
   *  rate window. `declared` is the descriptor as the registry declares it —
   *  what the live grade has to be resolved from again. */
  async #commitPreviewed(
    completed: CompletedDecision,
    call: ToolCall,
    declared: ToolDescriptor,
    ctx: RunContext,
  ): Promise<CompletedDecision | undefined> {
    const { decision, descriptor } = completed;
    // First, for the reason #checkWithMetadata reads it first too: a frozen
    // guard spends nothing. The uncached gate in `bind().execute` blocks this
    // call correctly either way, but it does so AFTER this method — so without
    // the read here a freeze landing in between still burned the approval tap,
    // and the call parked again once the freeze lifted instead of running.
    if (await this.frozen()) return undefined;
    if (decision.action === "run") {
      const write = descriptor.risk !== "read";
      const runKey = ctx.trigger?.runId ?? ctx.sessionId;
      const writes = this.#writeCounts.get(runKey)?.count ?? 0;
      // Breakers are read live, not remembered: another call can have filled the
      // budget or the window since the preview, and a previewed "run" may not
      // outrank the breaker that would have parked it.
      const tripped = this.#peekCallsTripped(ctx.principal.subject)
        || (write && writes >= this.#maxWritesPerRun);
      if (tripped && !neverParkAppRead(descriptor, ctx)) return undefined;
      // The GRADE is re-resolved, never remembered: `resolveRisk` is a LIVE
      // lookup (in Vendo the app's grade plus the connector catalog), and the
      // grade this verdict carries is what THE LAW's unattended gate in `bind()`
      // reads. A tool that previewed as `read` and re-grades to `destructive`
      // must not reach an away run off the old label, so a verdict whose grade
      // moved is no longer a verdict for this call.
      const graded = await this.#effectiveDescriptor(call, declared, ctx);
      if (descriptorHash(graded) !== descriptorHash(descriptor)) return undefined;
      // Build contract §9.10 — the org-admin layer binds at DISPATCH as well as
      // at preview. An admin who tightens the layer while the call sits
      // previewed is exercising the one thing that may outrank what the user
      // already approved for themselves, so a rule that now outranks this
      // verdict voids it and the full pipeline applies the clamp for real.
      // Same carve-out `#checkWithMetadata` makes, for the same reason: a
      // CONSUMED approval skips the lookup, or park → approve → park never ends.
      const consumedApproval = decision.decidedBy === "grant" && decision.grantId === undefined;
      if (!consumedApproval) {
        const orgRule = await this.#orgRule(call, descriptor, ctx);
        if (orgRule !== undefined && strictness(orgRule.action) > strictness(decision.action)) {
          return undefined;
        }
      }
      // The authority itself is never remembered — it is the one thing reuse may
      // not skip. A standing grant is re-read, so a permission taken back
      // between the two passes still bites (grant-filter.test.ts); the human's
      // single-use yes is CLAIMED here, because the preview only read it
      // (`#approvedReplay`, claim false) and the claim belongs to the pass that
      // dispatches. It is the LAST thing read, after every gate above that can
      // still park or block the call, so a tap is only ever spent on a call that
      // proceeds. Either way it costs one query rather than the rules, the org
      // layer and the judge behind it.
      if (decision.decidedBy === "grant") {
        const authorized = consumedApproval
          ? await this.#approvedReplay(call, descriptor, ctx, true)
          : (await this.#matchingGrant(call, descriptor, ctx)).grant?.id === decision.grantId;
        if (!authorized) return undefined;
      }
      if (write) this.#writeCounts.set(runKey, { count: writes + 1, touchedAt: Date.now() });
    }
    this.#recordCall(ctx.principal.subject);
    return completed;
  }

  /**
   * Double-count: a "run" verdict here mutates the call-rate
   * window (#recordCall) and the write budget (below) as a side effect —
   * `check()`'s documented/tested contract is a fresh, un-memoized
   * evaluation every time (repeat calls with the identical id legitimately
   * expect a different answer once policy/ctx/state changes — see
   * policy.test.ts and approval-replay.test.ts), so those side effects can
   * never be skipped by remembering a PAST call's id or inputs.
   *
   * The agent bridge (packages/agent tools.ts) calls `guard.check()` twice
   * for what is, structurally, ONE logical call: once from the AI SDK's
   * `needsApproval` hook (a preview — "should the SDK pause before running
   * this?") and, when that preview says no, again moments later from
   * `execute()` (the REAL, dispatching check, reached through the
   * guard-bound registry — there is no unguarded path around it). Both
   * charge the SAME breakers for what the caller experiences as one call.
   *
   * `commitRun` is the fix: it distinguishes "decide, and if this resolves
   * to run, CHARGE for it" (the default — `check()`'s existing public
   * contract, and `bind().execute()`'s internal use) from "decide, without
   * charging a run" (the PREVIEW-ONLY seam `previewCheck()` below exposes).
   * A previewed "run" is deliberately un-committed: the caller who asked to
   * preview is never the one who gets to spend the budget, the window slot, or
   * a single-use approval — the very next real check (moments later, same
   * call) does that once, for real. A
   * previewed "ask"/"block" is unaffected either way — parking and audit
   * already happen exactly once, because the SDK never calls `execute()` at
   * all for a call its own preview paused.
   */
  async #checkWithMetadata(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
    commitRun = true,
  ): Promise<CompletedDecision> {
    // Read before any other stage so a frozen guard spends nothing: no risk
    // resolution, no breaker slot, no parked approval left for someone to
    // answer later. The freeze check deliberately runs BEFORE resolveRisk, so
    // the only grade in hand here is the descriptor's DECLARED label — which
    // `risk` (01-core §7) does not promise: it is the EFFECTIVE grade. Rather
    // than chip a possibly-wrong label, the frozen row OMITS `risk` entirely
    // (the console feed degrades cleanly to venue-led when risk is absent).
    if (await this.frozen({ cached: true })) {
      // The block is the truth; the audit is best-effort. A `vendo_audit` that
      // is momentarily unavailable must never turn a freeze into an error (or,
      // worse, an un-block) — swallow the write failure and still return the
      // block.
      await this.#reportFrozenBlock(ctx, call);
      return { decision: { action: "block", reason: FROZEN_REASON, decidedBy: "frozen" }, descriptor };
    }

    const effectiveDescriptor = await this.#effectiveDescriptor(call, descriptor, ctx);
    const callsTripped = commitRun
      ? this.#recordCall(ctx.principal.subject)
      : this.#peekCallsTripped(ctx.principal.subject);
    const metadata = await this.#pipeline(call, effectiveDescriptor, ctx, commitRun);
    let draft = metadata.decision;

    // 05 §6: away runs hold only grants captured while present and bound to the
    // running app — a would-be "run" that is not grant-authorized (rule, code,
    // judge, or the default posture) parks instead of running. This applies to
    // READS too: away execution has no live session to act as the user through,
    // so it needs captured authority (a grant) to call the host as them. The
    // automation ENABLE flow captures grants for every tool it uses, reads
    // included, so an enabled automation runs its reads via `decidedBy: grant`;
    // an ungranted away read parks (approve → grant → future runs succeed)
    // rather than erroring at execution with no actAs authority.
    if (ctx.presence === "away" && draft.action === "run" && draft.decidedBy !== "grant") {
      draft = { action: "ask", decidedBy: "default" };
    }

    // Build contract §9.10 — the org-admin layer, evaluated here and nowhere
    // else: a strictness CLAMP between host policy and the user's own
    // approvals. It deliberately binds grant-authorized drafts (an admin
    // tightening their members' agents is precisely a rule over what those
    // members already approved for themselves), and it can only move a decision
    // up the rank run < ask < block — which is what makes "host policy always
    // wins, org policy tightens never loosens" structural rather than a promise.
    // THE LAW's call-time gate stays downstream of it, untouched.
    //
    // ONE carve-out, and it is the same one THE LAW makes below (`replayApproved`
    // in `bind`): a run/"grant" with NO grantId is a one-time CONSUMED approval —
    // a human just tapped this exact call with these exact arguments, moments
    // ago, which is the very thing an org "ask" asked for. Re-clamping it made
    // "ask" unsatisfiable: park → approve → park, forever, with the call never
    // getting through. A STANDING grant (grantId present) stays bound on
    // purpose: an org ask over a remembered grant means confirm-every-time, and
    // that is the point of the layer.
    //
    // Stated rather than discovered: the carve-out skips the whole org lookup,
    // so it skips `block` too — an org rule that FORBIDS this call does not stop
    // a consumed approval for it, even though nothing about `block` is
    // unsatisfiable. That is the trade, and it is bounded to one already-tapped
    // call: the alternative is asking the guard to tell `ask` and `block` apart
    // before it has read the rule, and any such split re-opens the park →
    // approve → park loop for `ask`.
    //
    // Known and accepted: an org rule adopted BETWEEN a park and its approval is
    // not applied to that one call — the consumed replay is already authorized by
    // the human who tapped it. That is the same time-of-check window host policy
    // has always had for approved replays, not a new one, and closing it would
    // re-open the unsatisfiable-ask hole above.
    const consumedApproval = draft.action === "run"
      && draft.decidedBy === "grant" && draft.grantId === undefined;
    const orgRule = consumedApproval
      ? undefined
      : await this.#orgRule(call, effectiveDescriptor, ctx);
    if (orgRule !== undefined && strictness(orgRule.action) > strictness(draft.action)) {
      // Only "ask" and "block" can outrank a draft — "run" is the floor — so the
      // else arm here is reached exactly when the org rule says ask.
      draft = orgRule.action === "block"
        ? { action: "block", reason: orgRule.note ?? "blocked by org policy", decidedBy: "org" }
        : { action: "ask", decidedBy: "org" };
    }

    if (draft.action === "run") {
      // `ungraded` spends the write budget too: the budget exists to bound how
      // much a single run can change, and a tool nobody has graded is exactly
      // the one we cannot say is harmless.
      const write = effectiveDescriptor.risk !== "read";
      const runKey = ctx.trigger?.runId ?? ctx.sessionId;
      const writes = this.#writeCounts.get(runKey)?.count ?? 0;
      const writesTripped = write && writes >= this.#maxWritesPerRun;

      // A tripped call-rate breaker never parks a present app-venue read
      // (neverParkAppRead): the call still counts toward the window — which
      // keeps throttling everything else — but the read runs, because its
      // parked approval would starve the rendering surface forever. Writes
      // (which is all writesTripped can be) always park.
      if ((callsTripped || writesTripped) && !neverParkAppRead(effectiveDescriptor, ctx)) {
        draft = { action: "ask", decidedBy: "breaker" };
      } else if (write && commitRun) {
        // Uncommitted preview: the run is real, but the SPEND is not — the
        // moments-later real check (execute, commitRun=true) does this once.
        this.#writeCounts.set(runKey, { count: writes + 1, touchedAt: Date.now() });
      }
    }

    if (draft.action === "ask" && await this.#standingDenial(call, effectiveDescriptor, ctx)) {
      draft = { action: "block", reason: "you denied this", decidedBy: "denied" };
    }

    if (draft.action === "ask") {
      const invalidated = metadata.invalidatedGrants ?? [];
      const approval = await this.#parkApproval(call, effectiveDescriptor, ctx, invalidated[0]);
      const decision: GuardDecision = {
        action: "ask",
        approval,
        decidedBy: draft.decidedBy,
      };
      const first = invalidated[0];
      if (first !== undefined) {
        await this.report(
          eventFromContext(ctx, {
            kind: "policy-decision",
            tool: call.tool,
            risk: effectiveDescriptor.risk,
            inputPreview: approval.inputPreview,
            outcome: "pending-approval",
            decidedBy: "default",
            detail: {
              reason: "grant-invalidated",
              grantIds: invalidated.map((grant) => grant.id),
              tool: call.tool,
              staleHash: first.descriptorHash,
              currentHash: descriptorHash(effectiveDescriptor),
            },
          }),
        );
      }
      await this.report(
        eventFromContext(ctx, {
          kind: "approval",
          tool: call.tool,
          risk: effectiveDescriptor.risk,
          inputPreview: approval.inputPreview,
          outcome: "pending-approval",
          decidedBy: decision.decidedBy,
          ...(metadata.rationale === undefined
            ? {}
            : { detail: { rationale: metadata.rationale } }),
        }),
      );
      return {
        decision,
        descriptor: effectiveDescriptor,
        ...(metadata.rationale === undefined ? {} : { rationale: metadata.rationale }),
      };
    }

    if (draft.action === "block") {
      await this.report(
        eventFromContext(ctx, {
          kind: "policy-decision",
          tool: call.tool,
          risk: effectiveDescriptor.risk,
          inputPreview: inputPreview(call),
          outcome: "blocked",
          decidedBy: draft.decidedBy,
          ...(metadata.rationale === undefined
            ? {}
            : { detail: { rationale: metadata.rationale } }),
        }),
      );
    }

    return {
      decision: draft,
      descriptor: effectiveDescriptor,
      ...(metadata.rationale === undefined ? {} : { rationale: metadata.rationale }),
    };
  }

  /** The STRICTEST org rule matching this call, or undefined when no org layer
   *  is configured, none matches, or the resolver could not answer.
   *
   *  A throw means the org's `policy.json` is unreadable or malformed. That
   *  applies NO org rules — the actions registry's posture (`registry.ts`): a
   *  layer that cannot be understood refuses to guess rather than silently
   *  LOOSEN what it was meant to tighten — and it lands on the audit trail, so
   *  the admin whose file is broken can see that their policy is not in force. */
  async #orgRule(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<PolicyRule | undefined> {
    const resolve = this.#config.orgPolicy;
    if (resolve === undefined) return undefined;
    let rules: PolicyRule[];
    try {
      rules = await resolve(ctx);
    } catch (error) {
      log({
        code: "guard.org-policy-unavailable",
        level: "warn",
        message: `[vendo] guard: org policy could not be resolved (${errorMessage(error)}) — no org rules were `
          + `applied to ${call.tool}. Host policy and user approvals still decided it.`,
      });
      await this.report(
        eventFromContext(ctx, {
          kind: "policy-decision",
          tool: call.tool,
          risk: descriptor.risk,
          detail: { reason: "org-policy-unavailable", message: errorMessage(error) },
        }),
      );
      return undefined;
    }
    let strictest: PolicyRule | undefined;
    for (const rule of rules) {
      if (!ruleMatches(rule, call.tool, descriptor.risk, ctx.venue, ctx.presence)) continue;
      if (strictest === undefined || strictness(rule.action) > strictness(strictest.action)) {
        strictest = rule;
      }
    }
    return strictest;
  }

  async #effectiveDescriptor(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<ToolDescriptor> {
    const resolveRisk = this.#config.resolveRisk;
    if (resolveRisk === undefined) return descriptor;
    try {
      return withResolvedRisk(descriptor, await resolveRisk(call, descriptor, ctx));
    } catch {
      // The static descriptor is the conservative fallback. Vendo's dynamic
      // edit descriptor is write-class, so lookup/classifier failures still ask.
      return descriptor;
    }
  }

  #recordCall(subject: string): boolean {
    const at = Date.now();
    const cutoff = at - 60_000;
    this.#sweepBreakerState(at);
    const active = (this.#callWindows.get(subject) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    active.push(at);
    this.#callWindows.set(subject, active);
    return active.length > this.#maxCallsPerMinute;
  }

  /** `#recordCall`'s read-only twin for `previewCheck` (commitRun=false): the
   *  same "would this trip the per-minute breaker" verdict, +1 for the call
   *  this preview itself represents (the moments-later real check registers
   *  it for real), but never touches `#callWindows` — a preview must answer
   *  truthfully without spending the window slot the real check still owes. */
  #peekCallsTripped(subject: string): boolean {
    const cutoff = Date.now() - 60_000;
    const active = (this.#callWindows.get(subject) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    return active.length + 1 > this.#maxCallsPerMinute;
  }

  /**
   * Bounds the in-memory maps (they would otherwise grow one entry per
   * subject / run key / previewed call for process lifetime). Runs at most once
   * per minute, piggybacked on check traffic. Consequence, documented: a run idle longer
   * than 60 minutes restarts its write budget — the deterministic backstop
   * favors bounded memory over counting across hour-long gaps.
   */
  #sweepBreakerState(at: number): void {
    if (at - this.#lastSweepAt < 60_000) return;
    this.#lastSweepAt = at;
    const windowCutoff = at - 60_000;
    for (const [subject, timestamps] of this.#callWindows) {
      if (!timestamps.some((timestamp) => timestamp > windowCutoff)) {
        this.#callWindows.delete(subject);
      }
    }
    const writeCutoff = at - 60 * 60_000;
    for (const [runKey, entry] of this.#writeCounts) {
      if (entry.touchedAt <= writeCutoff) this.#writeCounts.delete(runKey);
    }
    // A preview whose dispatch never came (a connect gate ruled the call out, a
    // harness threw between the two) leaves its verdict behind. Nothing may read
    // it a minute later, so nothing keeps it.
    for (const [key, entry] of this.#previewed) {
      if (entry.at <= windowCutoff) this.#previewed.delete(key);
    }
  }

  async #pipeline(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
    commitRun: boolean,
  ): Promise<DecisionMetadata> {
    // The two bookkeeping lookups read different collections (approvals vs
    // grants) and neither consults the other's answer, so they go out TOGETHER:
    // over a hosted store that is one pair of round trips instead of two
    // (measured against Vendo Cloud, p50 369ms → 274ms). Precedence below is
    // exactly as it was — the replay verdict is read first, the grant only
    // after it — and the replay's single-use CAS spend still happens once,
    // because `#approvedReplay` is still called once.
    //
    // The PREVIEW pass that precedes a dispatch runs this pipeline and the
    // dispatch reuses its verdict (`#decideForExecution`) — but neither read
    // here is reused, and both are repeated at commit time instead. The grant
    // is not a decision input the way a rule is — it IS the authority the call
    // executes on, so reusing the preview's answer would leave a window in
    // which a permission the person just took back still runs the tool. That is
    // the same window the freeze re-read below `bind().execute` exists to
    // close, and it gets the same answer: read it again. (The replay is
    // repeated for its own reason — the single-use CAS spend belongs to the
    // pass that dispatches.)
    const [replayable, matched] = await Promise.all([
      this.#approvedReplay(call, descriptor, ctx, commitRun),
      this.#matchingGrant(call, descriptor, ctx),
    ]);

    // An exact approved replay answers a confirmEach ask (05 §2 stays otherwise:
    // grants/rules/judge never suppress confirmEach — the grant lookup above is
    // read for its answer only once this tier has let the call through).
    if (descriptor.confirmEach === true && !replayable) {
      return { decision: { action: "ask", decidedBy: "confirmEach" } };
    }

    if (replayable) {
      return { decision: { action: "run", decidedBy: "grant" } };
    }

    const { grant, invalidated } = matched;
    if (grant !== undefined) {
      return {
        decision: {
          action: "run",
          decidedBy: "grant",
          grantId: grant.id,
        },
      };
    }
    const withInvalidated = (metadata: DecisionMetadata): DecisionMetadata =>
      invalidated.length === 0 ? metadata : { ...metadata, invalidatedGrants: invalidated };

    const rules = await this.#policy.rules();
    for (const rule of rules) {
      if (!ruleMatches(rule, call.tool, descriptor.risk, ctx.venue, ctx.presence)) continue;
      if (rule.action === "block") {
        return withInvalidated({
          decision: { action: "block", reason: rule.note ?? "blocked by policy rule", decidedBy: "rule" },
        });
      }
      return withInvalidated({ decision: { action: rule.action, decidedBy: "rule" } });
    }

    const code = this.#policyConfig?.code;
    if (code !== undefined) {
      try {
        const decision = code(call, descriptor, ctx);
        if (decision !== undefined) {
          return withInvalidated({ decision: normalizeCodeDecision(decision) });
        }
      } catch (error) {
        return withInvalidated({
          decision: { action: "ask", decidedBy: "rule" },
          rationale: errorMessage(error),
        });
      }
    }

    if (this.#config.judge !== undefined) {
      const directions = await this.#policy.directions();
      const recent = (await this.#queryAudit({ principal: ctx.principal, limit: 20 })).events;
      try {
        const judged = await this.#judgeWithTimeout(this.#config.judge, {
          call,
          descriptor,
          ctx,
          recent,
          directions,
        });
        // A judge "ask" on a present app-venue read coerces to run (run and
        // block stay the judge's to give — see neverParkAppRead).
        const action = judged.action === "ask" && neverParkAppRead(descriptor, ctx)
          ? "run"
          : judged.action;
        const decision: DraftDecision = action === "block"
          ? { action: "block", reason: judged.rationale, decidedBy: "judge" }
          : { action, decidedBy: "judge" };
        return withInvalidated({ decision, rationale: judged.rationale });
      } catch (error) {
        // Judge failure fails closed to ask — except for a present app-venue
        // read, where the fail-closed ask IS the failure mode (a permanently
        // starved surface); those run, exactly as the judge-less default does.
        return withInvalidated({
          decision: {
            action: neverParkAppRead(descriptor, ctx) ? "run" : "ask",
            decidedBy: "judge",
          },
          rationale: errorMessage(error),
        });
      }
    }

    // Nothing spoke. `ungraded` is a tool nobody has graded — no human, no
    // judge, no protocol fact — and `destructive` is one whose effect cannot be
    // taken back; both need a PERSON, so neither is hidden behind a run here.
    // Guard-level on purpose, so a hand-wired server with no policy config at
    // all gets it too. A host that consciously wants these to run says so in
    // writing, with a matching `risk` rule.
    //
    // `withheldFromUnattended` is the same two grades, and reading them off ONE
    // list is the point: §12 refuses them where there is nobody to ask, and this
    // asks where there is — the halves cannot drift apart into a default that
    // silently ran what the unattended law refuses.
    if (withheldFromUnattended(descriptor)) {
      return withInvalidated({ decision: { action: "ask", decidedBy: "default" } });
    }
    return withInvalidated({ decision: { action: "run", decidedBy: "default" } });
  }

  async #judgeWithTimeout(
    judge: Judge,
    input: Parameters<Judge["decide"]>[0],
  ): ReturnType<Judge["decide"]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const decision = judge.decide(input);
    // A timed-out judge may still settle later; swallow that late rejection so it
    // can never surface as an unhandled rejection after the race is over.
    void decision.catch(() => undefined);
    try {
      return await Promise.race([
        decision,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Judge timed out after ${JUDGE_TIMEOUT_MS}ms`)),
            JUDGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The ordinal for this call within its (run, tool, input) group. Stable per
   *  call id: asking twice for the same call id gives the same number, which is
   *  what makes a retry dedupe while a second distinct call does not. */
  #effectOrdinal(base: string, callId: string): number {
    let byCall = this.#effectOrdinals.get(base);
    if (byCall === undefined) {
      byCall = new Map();
      this.#effectOrdinals.set(base, byCall);
    }
    const existing = byCall.get(callId);
    if (existing !== undefined) return existing;
    const ordinal = byCall.size;
    byCall.set(callId, ordinal);
    return ordinal;
  }

  async #recordedEffect(key: string): Promise<ToolOutcome | undefined> {
    const record = await this.#engine.get(EFFECTS_COLLECTION, key);
    if (record === null) return undefined;
    const outcome = (record.data as { outcome?: unknown }).outcome;
    const parsed = toolOutcomeSchema.safeParse(outcome);
    // A row we cannot read is treated as absent: refusing to execute on the
    // strength of an unparseable receipt would strand the call forever.
    return parsed.success ? parsed.data : undefined;
  }

  /** Write the receipt through `insertIfAbsent`, so a racing writer cannot
   *  overwrite an already-recorded outcome.
   *
   *  Note precisely what that does and does not buy: it protects the RECORD, not
   *  the execution. Nothing is reserved before the call, so two PROCESSES can
   *  still both execute the same key — `#effectsInFlight` closes that window
   *  within one process only. Cross-process exclusion needs a reservation row the
   *  contract does not yet describe; it is reported, not silently implied.
   *
   *  `subject` rides the row (contract amendment 2026-07-30): `outcome` holds
   *  real tool output, so a receipt with no owner is data that would survive an
   *  erase forever. It goes in `refs` as well as the body, because that is what
   *  the 02-store §5 cascade matches on for generic collections. */
  async #recordEffect(key: string, outcome: ToolOutcome, subject: string): Promise<void> {
    await this.#engine.insertIfAbsent(EFFECTS_COLLECTION, {
      id: key,
      data: { subject, outcome: cloneJson(outcome) as Json, at: now() },
      refs: { subject },
    });
  }

  /** The dispatch itself, once the guard has said run and the freeze has been
   *  re-read: resolve the grant the call runs under, then hand it to the
   *  registry exactly once per effect key. */
  async #runOnce(
    tools: ToolRegistry,
    call: ToolCall,
    decision: GuardDecision,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<ToolOutcome> {
    const grant = await this.#grantForExecution(decision, call, descriptor, ctx);
    // CORE-2: `grant` is a first-class RunContext field — no cast needed.
    const executeCtx = grant === undefined ? ctx : { ...ctx, grant };
    // Build contract §7: for a MUTATING call, a key that already succeeded
    // returns its recorded outcome INSTEAD of executing. The check sits
    // here, after the guard has said run and before the registry is
    // touched, because that is the only point where skipping is both safe
    // (authority was still checked) and effective (the effect is avoided).
    //
    // The DECLARED label decides — the dev's label is final (two-vote
    // grading removed), so a declared `read` is silent and takes no
    // receipt.
    const risk = descriptor.risk;
    const mutating = risk === "write" || risk === "destructive";
    const base = mutating ? effectBaseKey(ctx, call) : undefined;
    const key = base === undefined ? undefined : effectKeyOf(base, this.#effectOrdinal(base, call.id));
    const recorded = key === undefined ? undefined : await this.#recordedEffect(key);
    if (recorded !== undefined) return recorded;
    // Finding 14 (TOCTOU): two concurrent identical calls both read "no
    // receipt" and both executed. Share one in-flight execution per key
    // so the second awaits the first's outcome instead of repeating it.
    const inFlight = key === undefined ? undefined : this.#effectsInFlight.get(key);
    if (inFlight !== undefined) return await inFlight;
    const run = (async (): Promise<ToolOutcome> => {
      try {
        return await tools.execute(call, executeCtx);
      } catch (error) {
        return {
          status: "error",
          error: {
            code: isVendoError(error) ? error.code : "error",
            message: errorMessage(error),
          },
        };
      }
    })();
    if (key !== undefined) this.#effectsInFlight.set(key, run);
    let outcome: ToolOutcome;
    try {
      outcome = await run;
    } finally {
      if (key !== undefined) this.#effectsInFlight.delete(key);
    }
    // A call just landed, and the judge decides on the audit trail — so every
    // verdict still previewed for this SUBJECT was decided by a judge that
    // could not see it. Void them: the next dispatch re-decides against a trail
    // that includes it. The AI-SDK brain previews a whole step's tools before it
    // dispatches any of them, so without this the second call of a parallel pair
    // runs on a verdict taken before the first one existed. The scope is the
    // subject at ANY grade because that is `#queryAudit`'s scope in
    // `#checkWithMetadata`: a narrower void leaves the judge blind to a landed
    // read, a landed ungraded connector call, or the person's other session.
    for (const [previewedKey, entry] of this.#previewed) {
      if (entry.subject === ctx.principal.subject) this.#previewed.delete(previewedKey);
    }
    // Only a SUCCESS is ledgered. A failed mutation may not have landed
    // at all, so recording it would turn a transient upstream error into
    // a permanent refusal to retry — the opposite of the goal.
    if (key !== undefined && outcome.status === "ok") {
      // The mutation ALREADY HAPPENED. A receipt-store failure must
      // never discard it: throwing here would lose both the caller's
      // outcome and the audit row for real, completed work. Surface it
      // loudly and carry on — an unrecorded receipt risks a duplicate
      // on a later re-run, which is strictly better than losing the
      // record of a payment that went out.
      try {
        await this.#recordEffect(key, outcome, ctx.principal.subject);
      } catch (error) {
        log({
          code: "guard.effect-receipt-unwritten",
          level: "error",
          message: `[vendo] guard: ${call.tool} completed but its effect receipt could not be written `
            + `(${errorMessage(error)}). A re-run of this run may repeat the call.`,
        });
      }
    }
    return outcome;
  }

  async #grantForExecution(
    decision: GuardDecision,
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<PermissionGrant | undefined> {
    if (decision.action !== "run") return undefined;
    if (decision.grantId !== undefined) {
      const record = await this.#engine.get(GRANTS_COLLECTION, decision.grantId);
      return record === null ? undefined : (record.data as PermissionGrant);
    }
    if (ctx.presence !== "away") return undefined;
    const captured = (await this.#matchingGrant(call, descriptor, ctx)).grant;
    if (captured !== undefined || decision.decidedBy !== "grant") return captured;
    // A run/"grant" with NO grantId is a CONSUMED APPROVAL (`replayApproved` in
    // `bind`): a person tapped THIS call, with these arguments, moments ago. Away
    // execution has one other authority besides a captured grant, and that is it
    // — but the seam that authenticates the call (`actAs`) takes a grant, so the
    // tap arrived with nothing to hand it and the registry refused the very call
    // the human had just allowed ("away execution requires a captured grant").
    // The tap is therefore projected INTO the shape the seam asks for, scoped
    // `exact` to the arguments they were shown: never stored, never returned by
    // `#matchingGrant`, spent with the approval that made it. It authorizes this
    // one call and grants no standing authority, so the next call asks again —
    // the same rule, and the same reason, as the MCP door's consent projection
    // (`mcpConsentGrant`, actions registry).
    return {
      id: `grt_approved_${call.id}`,
      subject: ctx.principal.subject,
      tool: call.tool,
      descriptorHash: descriptorHash(descriptor),
      scope: { kind: "exact", inputHash: exactInputHash(call.args), inputPreview: inputPreview(call) },
      duration: "task",
      contextKey: call.id,
      ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
      source: "approval",
      grantedAt: now(),
    };
  }

  /** Wins (or loses) an approval's one-time transition by inserting its
   *  receipt through the store's atomic `insertIfAbsent` — a single statement,
   *  so exactly one claimant succeeds no matter how many processes race. Fails
   *  closed when the store omits the capability — the verb itself refuses with
   *  `not-implemented`: single-use state cannot be guaranteed without
   *  database-level CAS (02-store §4).
   *
   *  The `consumed` transition has TWO kinds of claimant: a replay spending the
   *  yes, and a void taking the decision back. They contend on the one receipt,
   *  so a call can never both run and be voided; the receipt records WHICH won,
   *  so the loser can say honestly what beat it. */
  async #claimApprovalTransition(
    transition: "decided" | "consumed",
    approvalId: string,
    subject: string,
    claimant?: "replay" | "void",
  ): Promise<boolean> {
    const receipt = await this.#engine.insertIfAbsent(APPROVAL_CLAIMS_COLLECTION, {
      id: `${transition}:${approvalId}`,
      data: { approvalId, transition, at: now(), ...(claimant === undefined ? {} : { claimant }) },
      refs: { subject },
    });
    return receipt !== null;
  }

  /** Which claimant holds an approval's `consumed` transition. Read only by a
   *  LOSER, to tell "the yes was spent" from "it was already taken back".
   *
   *  MIXED-VERSION WINDOW: receipts written before claimants existed carry none,
   *  and read as `undefined` here — which the void path treats as "spent". That
   *  is the fail-closed reading and the true one: the older build claimed this
   *  receipt only from the replay path. */
  async #consumedTransitionClaimant(approvalId: string): Promise<"replay" | "void" | undefined> {
    const receipt = await this.#engine.get(APPROVAL_CLAIMS_COLLECTION, `consumed:${approvalId}`);
    const claimant = (receipt?.data as { claimant?: unknown } | undefined)?.claimant;
    return claimant === "void" || claimant === "replay" ? claimant : undefined;
  }

  /**
   * Spends an approval as a REPLAY would: claim the one-time `consumed`
   * transition, then mark the row. Shared by the replay lookup and the
   * automations engine's {@link spendApproval} seam so the two can never
   * disagree about what spending means.
   *
   * The claim is the gate; the marker is observability, so a crash between them
   * fails closed (the row reads un-consumed but can never be claimed again).
   * Two things can still cost the spend after a won claim: a GONE row — subject
   * erasure (02-store §5) DELETEs approval rows, and re-putting the caller's
   * stale copy would resurrect an erased subject's approval AND run the tool as
   * them — and a void that beat the claim, which must not be overwritten. Hence
   * the re-read.
   */
  async #spendConsumedTransition(
    id: string,
    subject: string,
  ): Promise<"spent" | "already-spent" | "taken-back"> {
    if (!(await this.#claimApprovalTransition("consumed", id, subject, "replay"))) {
      return (await this.#consumedTransitionClaimant(id)) === "void" ? "taken-back" : "already-spent";
    }
    const current = await this.#engine.get(APPROVALS_COLLECTION, id);
    if (current === null) return "already-spent";
    const fresh = approvalData(current);
    if (fresh.voidedAt !== undefined) return "taken-back";
    const spent: ApprovalRecordData = { ...fresh, consumedAt: now() };
    await this.#engine.put(APPROVALS_COLLECTION, { id, data: spent, refs: approvalRefs(spent) });
    return "spent";
  }

  /**
   * Takes a decision back, SPENDING the approval's one-time transition to do
   * it. Voiding and replaying claim the SAME `consumed:<id>` receipt, so they
   * linearize: without that, a void's plain put could land on a row a replay
   * had already read and erase the void marker while the tool ran anyway.
   *
   * - `voided` — this call took it back; the caller records it.
   * - `already-void` — the take-back had already landed: idempotent, and nothing
   *   to say twice.
   * - `spent` — a replay won the transition, so the call it authorized is
   *   running or ran. The take-back came too late and must never read as
   *   success.
   */
  async #voidApprovalDecision(
    id: string,
    data: ApprovalRecordData,
  ): Promise<"voided" | "already-void" | "spent"> {
    const claimed = await this.#claimApprovalTransition(
      "consumed",
      id,
      data.request.ctx.principal.subject,
      "void",
    );
    // A REPLAY holding the receipt means the call already ran. Losing it to
    // another VOID does not prove that void's marker landed, though: the receipt
    // is durable BEFORE the row write, so a take-back whose put failed leaves
    // the receipt claimed and the row still standing. Fall through and re-assert
    // it — otherwise the retry would report success while a human denial kept
    // blocking.
    if (!claimed && (await this.#consumedTransitionClaimant(id)) !== "void") return "spent";
    // Re-read rather than trusting the caller's copy, which may predate a decide
    // landing on the same row: the receipt, not that copy, is the gate. A row
    // that is GONE was erased (02-store §5) while this was in flight; re-putting
    // it would resurrect erased data, so there is nothing left to void.
    const current = await this.#engine.get(APPROVALS_COLLECTION, id);
    if (current === null) return "already-void";
    const fresh = approvalData(current);
    // The take-back this call is retrying already landed: nothing to say twice.
    if (!claimed && fresh.voidedAt !== undefined) return "already-void";
    const voided: ApprovalRecordData = { ...fresh, voidedAt: fresh.voidedAt ?? now() };
    await this.#engine.put(APPROVALS_COLLECTION, { id, data: voided, refs: approvalRefs(voided) });
    return "voided";
  }

  /** Releases transition receipts a BATCH decide won before its claim phase
   *  failed — deleting a receipt re-opens the one-time transition. Only ever
   *  called before ANY member of the batch committed, so a re-opened
   *  transition can never re-decide a written row. Best-effort per receipt: a
   *  failed delete leaves that approval claimed-but-undecided, which keeps
   *  failing closed (conflict) rather than ever going partial. */
  async #releaseApprovalTransitions(
    transition: "decided" | "consumed",
    approvalIds: string[],
  ): Promise<void> {
    for (const approvalId of approvalIds) {
      try {
        await this.#engine.delete(APPROVAL_CLAIMS_COLLECTION, `${transition}:${approvalId}`);
      } catch {
        // Fail closed: the stuck receipt only makes later decides conflict.
      }
    }
  }

  /**
   * Has the user already said no to exactly this call?
   *
   * A caller that re-issues a STABLE call id — the apps runtime derives a
   * query's id from (app, tool, args), so its refetch is byte-identical — would
   * otherwise mint a fresh approval on every retry: deny, reopen, new card,
   * forever. The denial answers the re-issue instead.
   *
   * Unlike an approval this is NOT consumed. A yes is spent because it
   * authorizes one act; a no is a standing answer about a question, and it
   * keeps standing until the question changes — different inputs, or a tool
   * whose descriptor moved (a re-grade rehashes it) both miss this match and
   * ask again.
   *
   * ONLY A PERSON'S NO STANDS. Four different things write a denied row — a
   * real decision, the chat turn the user walked away from, a BYO embed timing
   * out, the 60-minute TTL sweep — and three of them are housekeeping, not an
   * answer. Enforcing those would let an hour of inattention permanently brick
   * a ceremony that re-issues a stable call id (the apps runtime's secret and
   * egress approvals do exactly that behind frozen descriptors). A system
   * denial reaps the pending row and nothing more: the next issue asks again.
   *
   * KNOWN LIMIT: `descriptorHash` covers name, description, inputSchema, risk
   * and confirmEach — NOT the binding. A host that re-points a route behind a
   * byte-identical descriptor inherits the old denial, because from the user's
   * side nothing they were shown has changed. Re-pointing a live route under
   * an unchanged descriptor is already indistinguishable at the consent
   * surface; `approvals.revoke` is the way out.
   */
  async #standingDenial(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<boolean> {
    const fingerprint = descriptorHash(descriptor);
    // Indexed on the call id: chat's random ids miss here and never pay for a
    // scan of the subject's history.
    const records = await listAll(this.#engine, APPROVALS_COLLECTION, {
      refs: { subject: ctx.principal.subject, status: "denied", call: call.id },
    });
    return records.some((record) => {
      const data = approvalData(record);
      return data.status === "denied"
        && data.deniedBy === "human"
        && data.voidedAt === undefined
        && sameParkedCall(data.request, call, ctx, fingerprint);
    });
  }

  /** Is there an approved, unspent replay for exactly this call — and, when
   *  `claim` is true, spend it? `claim` is false for a preview (commitRun
   *  false): a preview dispatches nothing, so spending the human's one yes
   *  there would strand the real call moments later in park → approve → park,
   *  with the tap burned. The real check that follows claims it, once. */
  async #approvedReplay(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
    claim: boolean,
  ): Promise<boolean> {
    const fingerprint = descriptorHash(descriptor);
    const records = await listAll(this.#engine, APPROVALS_COLLECTION, {
      refs: { subject: ctx.principal.subject, status: "approved", call: call.id },
    });
    for (const record of records) {
      const data = approvalData(record);
      const request = data.request;
      // Sessions are DELIBERATELY not among the things `sameParkedCall` pins.
      // One person approving on their phone and seeing the result render on
      // their laptop is the same person answering the same question — the
      // identity that matters is the subject, and everything that could change
      // what they said yes to (inputs, frozen descriptor, venue/presence/app) is
      // pinned there. Single-use is enforced by the CAS receipt below, so a
      // cross-session replay still spends the one approval rather than
      // multiplying it. Documented so it stays a choice.
      if (
        data.status !== "approved"
        || data.consumedAt !== undefined
        // Voided: the person took this yes back, or their later no on the same
        // call superseded it. Parking never dedupes, so a stable call id can
        // hold both an older approved row and a newer denied one — without
        // this, the stale yes would run right after the fresh no.
        || data.voidedAt !== undefined
        || !sameParkedCall(request, call, ctx, fingerprint)
      ) {
        continue;
      }
      // Single-use is enforced by the receipt, not by the consumedAt read above
      // (that check is only a fast path): the atomic insert has exactly one
      // winner across processes. Anything short of `spent` falls through to the
      // next candidate — the same approved call parked twice yields two
      // approvals, each replayable once, exactly as before, and a lost claim can
      // also mean the person took the yes back between the list and here.
      if (!claim) return true;
      if (await this.#spendConsumedTransition(record.id, ctx.principal.subject) !== "spent") continue;
      return true;
    }
    return false;
  }

  async #matchingGrant(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<{ grant?: PermissionGrant; invalidated: PermissionGrant[] }> {
    // `tool` is an indexed column on the routed grants door — (subject, tool) —
    // so the predicate rides the query instead of paging every grant the
    // subject ever held back to filter it here. The rest of the tests below
    // read fields no door indexes, which is why they stay in JavaScript.
    const records = await listAll(this.#engine, GRANTS_COLLECTION, {
      refs: { subject: ctx.principal.subject, tool: call.tool },
    });
    const fingerprint = descriptorHash(descriptor);
    const at = Date.now();
    const invalidated: PermissionGrant[] = [];

    for (const record of records) {
      const grant = grantData(record);
      const expiresAt = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt);
      if (grant.subject !== ctx.principal.subject) continue;
      if (grant.revokedAt !== undefined) continue;
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= at)) continue;
      if (!durationMatches(grant, ctx) || !presenceMatches(grant, ctx)) continue;
      if (!scopeMatches(grant.scope, call)) continue;
      if (grant.descriptorHash !== fingerprint) {
        invalidated.push(grant);
        continue;
      }
      return { grant, invalidated };
    }
    return { invalidated };
  }

  async #parkApproval(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
    invalidatedGrant?: PermissionGrant,
  ): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: makeId("apr_") as ApprovalId,
      call: cloneJson(call),
      descriptor: cloneJson(descriptor),
      inputPreview: inputPreview(call),
      ...(invalidatedGrant === undefined
        ? {}
        : {
            invalidatedGrant: {
              id: invalidatedGrant.id,
              grantedAt: invalidatedGrant.grantedAt,
            },
          }),
      ctx: {
        principal: cloneJson(ctx.principal),
        venue: ctx.venue,
        presence: ctx.presence,
        // The owner identity the record below already keeps — ON the request
        // too, so subscribers can scope delivery to the parking conversation.
        sessionId: ctx.sessionId,
        ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
        ...(ctx.trigger === undefined ? {} : { trigger: cloneJson(ctx.trigger) }),
      },
      createdAt: now(),
    };
    const data: ApprovalRecordData = {
      request,
      status: "pending",
      sessionId: ctx.sessionId,
    };
    await this.#engine.put(APPROVALS_COLLECTION, { id: request.id, data, refs: approvalRefs(data) });
    // Subscribers see the park only after it persisted, and a returned
    // thenable is awaited (as decision callbacks are) so check() resolves
    // only after notification work lands. A subscriber failure never turns a
    // successfully parked ask into an error.
    for (const callback of this.#approvalRequestedCallbacks) {
      try {
        await (callback(request) as void | Promise<void>);
      } catch {
        // The approval row is the truth; notification is best-effort.
      }
    }
    return request;
  }

  async #pendingApprovals(principal: Principal): Promise<ApprovalRequest[]> {
    const records = await listAll(this.#engine, APPROVALS_COLLECTION, {
      refs: { subject: principal.subject, status: "pending" },
    });
    return records
      .map(approvalData)
      .filter(
        (data) =>
          data.status === "pending" && data.request.ctx.principal.subject === principal.subject,
      )
      .map((data) => data.request);
  }

  async #decideApprovals(
    ids: ApprovalId | ApprovalId[],
    decision: ApprovalDecision,
    principal: Principal,
    provenance: "human" | "system",
  ): Promise<void> {
    const normalizedIds = [...new Set(Array.isArray(ids) ? ids : [ids])];
    // A multi-id decide is a SET decision (a grant set's one consent moment):
    // it must land all-or-none — never a partially-granted set.
    const batch = normalizedIds.length > 1;
    const targetStatus = decision.approve ? "approved" : "denied";

    // Phase 1 — validate the WHOLE batch before touching any state. A batch
    // member already decided in the SAME direction is skipped (another
    // surface got there first; the remainder still converges on the set's
    // goal state — all granted / all denied). A member decided in the
    // OPPOSITE direction makes that goal unreachable, so the whole batch
    // conflicts with nothing written. Single-id decides keep the strict
    // one-time-transition semantics (any prior decision conflicts).
    const toDecide: Array<{ id: string; data: ReturnType<typeof approvalData> }> = [];
    for (const id of normalizedIds) {
      const record = await this.#engine.get(APPROVALS_COLLECTION, id);
      if (record === null) {
        throw new VendoError("not-found", `Approval ${id} was not found`);
      }
      const data = approvalData(record);
      if (data.request.ctx.principal.subject !== principal.subject) {
        throw new VendoError("not-found", `Approval ${id} was not found`);
      }
      if (data.status !== "pending") {
        if (batch && data.status === targetStatus) continue;
        throw new VendoError("conflict", `Approval ${id} has already been decided`);
      }
      toDecide.push({ id, data });
    }

    // Phase 2 — claim EVERY undecided member before committing ANY of them.
    // pending → decided happens once: the receipt's atomic insert picks a
    // single winner, so a concurrent approve and deny can never both act —
    // no contradictory audit records, and no live grant minted for an
    // approval whose stored status says denied. Sorted order makes racing
    // set-deciders contend on the same first id (one wins the whole set, the
    // other loses before holding anything); a lost claim releases the
    // receipts this batch DID win, so a partial set can never commit.
    toDecide.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const claimed: string[] = [];
    for (const member of toDecide) {
      if (await this.#claimApprovalTransition("decided", member.id, principal.subject)) {
        claimed.push(member.id);
        continue;
      }
      await this.#releaseApprovalTransitions("decided", claimed);
      throw new VendoError("conflict", `Approval ${member.id} has already been decided`);
    }

    // Phase 3 — commit, with COMPENSATION: holding every transition receipt
    // protects the batch from other deciders, but not from the store itself
    // failing mid-batch. A member write that throws rolls the already-applied
    // members back (minted grants deleted, asks restored to pending, reversal
    // audits written, transitions released) and rethrows the original failure
    // — the set stays all-or-none against storage faults and the retry finds
    // every ask pending again. If the rollback ITSELF fails, a loud audit
    // records the partial state and the thrown error names the approvals to
    // review — never silent partial grants. Subscriber callbacks fire only
    // after EVERY member landed, so downstream effects (standing-grant
    // minting, parked-call resumption) can never observe a set that later
    // rolled back.
    const applied: Array<{ id: string; prior: ReturnType<typeof approvalData>; grantId?: GrantId }> = [];
    try {
      for (const { id, data } of toDecide) {
        await this.#commitDecidedMember(id, data, decision, normalizedIds.length > 1, principal, provenance, applied);
      }
    } catch (error) {
      await this.#compensateDecidedMembers(applied, claimed, principal, error);
      throw error;
    }
    for (const { id } of toDecide) {
      // A subscriber may re-enter the guard (e.g. re-execute the resumed
      // call), so callbacks fire only after the WHOLE set's writes landed.
      // A returned thenable is awaited so decide() resolves only after
      // resumption work lands — fire-and-forget subscribers would otherwise
      // race the caller (e.g. a store closing under in-flight writes).
      for (const callback of this.#approvalCallbacks) {
        try {
          await (callback(id, decision.approve) as void | Promise<void>);
        } catch {
          // Approval persistence must not be rolled back by an in-process subscriber.
        }
      }
    }
  }

  /**
   * A person's no also voids any UNCONSUMED yes still sitting on the same
   * call. Parking never dedupes, so one stable call id can hold an older
   * approved row and a newer denied one; without this the replay lookup would
   * find the stale approval and run the very thing that was just refused.
   * Voided rather than deleted — the audit trail keeps both answers, in order.
   */
  async #supersedeApprovedSiblings(denied: ApprovalRecordData): Promise<void> {
    const fingerprint = descriptorHash(denied.request.descriptor);
    const siblings = await listAll(this.#engine, APPROVALS_COLLECTION, {
      refs: {
        subject: denied.request.ctx.principal.subject,
        status: "approved",
        call: denied.request.call.id,
      },
    });
    for (const record of siblings) {
      const data = approvalData(record);
      if (data.consumedAt !== undefined || data.voidedAt !== undefined) continue;
      // The SAME matcher the replay and standing-denial lookups use: a no must
      // void exactly the yeses that answer the identical question, so the three
      // can never drift into meaning different calls.
      if (!sameParkedCall(data.request, denied.request.call, denied.request.ctx, fingerprint)) continue;
      if (await this.#voidApprovalDecision(record.id, data) !== "spent") continue;
      // The yes was being spent as the no landed, so the call ran. The denial
      // still stands for every later issue, but the trail must not imply this
      // one was stopped.
      await this.report(
        eventFromContext(denied.request.ctx as RunContext, {
          kind: "approval",
          tool: denied.request.call.tool,
          inputPreview: denied.request.inputPreview,
          detail: { supersedeTooLate: record.id },
        }),
      );
    }
  }

  /** One member's committed writes: the decided approval row, the optional
   *  remembered grant, and the audit record. Every landed write is pushed
   *  onto `applied` FIRST, so a failure anywhere leaves an exact rollback
   *  plan for {@link #compensateDecidedMembers}. */
  async #commitDecidedMember(
    id: string,
    data: ReturnType<typeof approvalData>,
    decision: ApprovalDecision,
    batch: boolean,
    principal: Principal,
    provenance: "human" | "system",
    applied: Array<{ id: string; prior: ReturnType<typeof approvalData>; grantId?: GrantId }>,
  ): Promise<void> {
    const decidedAt = now();
    const status = decision.approve ? "approved" : "denied";
    const entry: { id: string; prior: ReturnType<typeof approvalData>; grantId?: GrantId } = { id, prior: data };
    const decided: ApprovalRecordData = {
      ...data,
      status,
      decidedAt,
      ...(decision.approve ? {} : { deniedBy: provenance }),
    };
    await this.#engine.put(APPROVALS_COLLECTION, { id, data: decided, refs: approvalRefs(decided) });
    applied.push(entry);
    if (!decision.approve && provenance === "human") await this.#supersedeApprovedSiblings(decided);

    let grantId: GrantId | undefined;
    if (decision.approve && decision.remember !== undefined) {
      grantId = await this.mintGrant({
        request: data.request,
        remember: {
          duration: decision.remember.duration,
          scope: normalizeRememberedScope(decision.remember.scope, data.request),
        },
        source: batch ? "batch" : "chat",
        contextKey: data.sessionId,
      });
      entry.grantId = grantId;
    }

    const requestCtx = data.request.ctx;
    await this.report({
      id: makeId("aud_"),
      at: now(),
      kind: "approval",
      principal: requestCtx.principal,
      venue: requestCtx.venue,
      presence: requestCtx.presence,
      ...(requestCtx.appId === undefined ? {} : { appId: requestCtx.appId }),
      ...(requestCtx.trigger === undefined ? {} : { trigger: requestCtx.trigger }),
      tool: data.request.call.tool,
      inputPreview: data.request.inputPreview,
      detail: {
        approved: decision.approve,
        ...(grantId === undefined ? {} : { grantId }),
      },
    });
  }

  /** Rolls back the members a failed batch commit already applied: minted
   *  grants are deleted, decided rows restored to pending, reversal audits
   *  written (the ledger stays truthful about the round trip), and the
   *  batch's transition receipts released so a retry finds every ask
   *  decidable. When the rollback itself fails, a loud audit records the
   *  partial state and the thrown error names the approvals to review —
   *  a partially granted set is never silent. */
  async #compensateDecidedMembers(
    applied: Array<{ id: string; prior: ReturnType<typeof approvalData>; grantId?: GrantId }>,
    claimed: string[],
    principal: Principal,
    cause: unknown,
  ): Promise<void> {
    let rollbackFailed = false;
    for (const member of [...applied].reverse()) {
      try {
        if (member.grantId !== undefined) {
          await this.#engine.delete(GRANTS_COLLECTION, member.grantId);
        }
        // Restore only a row nothing else has acted on. In the ms between this
        // member's commit and a LATER member's store failure, a concurrent
        // replay can spend it and a take-back can void it — and both of those
        // transitions are single-use, so re-opening the ask would advertise a
        // decision no one can make again and erase the marker of what did
        // happen. A gone row was erased (02-store §5) and must never be
        // re-created here. Both cases leave the member decided, which its own
        // audit line already says; the retry then reads it as decided.
        const current = await this.#engine.get(APPROVALS_COLLECTION, member.id);
        if (current === null) continue;
        const live = approvalData(current);
        if (live.consumedAt !== undefined || live.voidedAt !== undefined) continue;
        await this.#engine.put(
          APPROVALS_COLLECTION,
          { id: member.id, data: member.prior, refs: approvalRefs(member.prior) },
        );
        const requestCtx = member.prior.request.ctx;
        try {
          await this.report({
            id: makeId("aud_"),
            at: now(),
            kind: "approval",
            principal: requestCtx.principal,
            venue: requestCtx.venue,
            presence: requestCtx.presence,
            ...(requestCtx.appId === undefined ? {} : { appId: requestCtx.appId }),
            tool: member.prior.request.call.tool,
            inputPreview: member.prior.request.inputPreview,
            detail: { setDecisionRolledBack: true },
          });
        } catch {
          // The reversal itself landed; a missing reversal audit must not
          // fail the compensation that keeps the set all-or-none.
        }
      } catch {
        rollbackFailed = true;
      }
    }
    if (!rollbackFailed) {
      // Every applied member is pending again — reopen the whole batch's
      // transitions so the retry can decide the set cleanly.
      await this.#releaseApprovalTransitions("decided", claimed);
      return; // the caller rethrows the original storage failure
    }
    const partial = applied.map((member) => member.id).join(", ");
    try {
      await this.report({
        id: makeId("aud_"),
        at: now(),
        kind: "approval",
        principal,
        venue: "chat",
        presence: "present",
        tool: "approvals.decide",
        inputPreview: `set decision rollback FAILED — review: ${partial}`,
        detail: { setRollbackFailed: true, approvals: partial },
      });
    } catch {
      // The thrown conflict below still surfaces the partial state loudly.
    }
    throw new VendoError(
      "conflict",
      `The decision could not be applied to the whole set and rolling back also failed (${
        cause instanceof Error ? cause.message : String(cause)
      }). Review these approvals in Activity before retrying: ${partial}`,
    );
  }

  async #listGrants(principal: Principal): Promise<PermissionGrant[]> {
    const records = await listAll(this.#engine, GRANTS_COLLECTION, {
      refs: { subject: principal.subject },
    });
    return records
      .map(grantData)
      .filter((grant) => grant.subject === principal.subject);
  }

  /**
   * "I take that back." The mirror of {@link #revokeGrant}, for the other
   * durable answer a person can give: a decided approval stops standing, so a
   * denial no longer answers its call and an unconsumed approval can no longer
   * replay. Without it a misclicked no on a frozen-descriptor ceremony (the
   * apps runtime's secret and egress approvals re-issue a stable call id) would
   * have no undo at all. Owner-scoped like every approval read: a foreign or
   * unknown id is not-found, never a hint that it exists. Idempotent, and a
   * still-pending approval is nothing to take back — deny it instead.
   */
  async #revokeApproval(id: ApprovalId, principal: Principal): Promise<void> {
    const record = await this.#engine.get(APPROVALS_COLLECTION, id);
    if (record === null) throw new VendoError("not-found", `Approval ${id} was not found`);
    const data = approvalData(record);
    if (data.request.ctx.principal.subject !== principal.subject) {
      throw new VendoError("not-found", `Approval ${id} was not found`);
    }
    if (data.status === "pending") {
      throw new VendoError("conflict", `Approval ${id} has not been decided yet`);
    }
    const outcome = await this.#voidApprovalDecision(id, data);
    // Already taken back: idempotent, and the trail says it once.
    if (outcome === "already-void") return;
    if (outcome === "spent") {
      throw new VendoError(
        "conflict",
        `Approval ${id} was already spent by the call it authorized, so there is nothing left to take back`,
      );
    }
    try {
      await this.report(
        eventFromContext(data.request.ctx as RunContext, {
          kind: "approval",
          tool: data.request.call.tool,
          inputPreview: data.request.inputPreview,
          detail: { approvalRevoked: id, priorStatus: data.status },
        }),
      );
    } catch {
      // The take-back itself landed; a missing audit line must not report it as
      // a failure the caller should retry (the retry would say "already void").
    }
  }

  async #revokeGrant(id: GrantId, principal: Principal): Promise<void> {
    const record = await this.#engine.get(GRANTS_COLLECTION, id);
    if (record === null) throw new VendoError("not-found", `Grant ${id} was not found`);
    const grant = grantData(record);
    if (grant.subject !== principal.subject) {
      throw new VendoError("not-found", `Grant ${id} was not found`);
    }
    const revoked: PermissionGrant = {
      ...grant,
      revokedAt: grant.revokedAt ?? now(),
    };
    const refs: Record<string, string> = {
      subject: revoked.subject,
      tool: revoked.tool,
    };
    if (revoked.appId !== undefined) refs.app_id = revoked.appId;
    await this.#engine.put(GRANTS_COLLECTION, { id, data: revoked, refs });
    await this.report({
      id: makeId("aud_"),
      at: now(),
      kind: "approval",
      principal,
      venue: "chat",
      presence: "present",
      tool: revoked.tool,
      detail: { grantRevoked: id },
    });
  }

  async #queryAudit(
    filter: AuditQueryFilter,
  ): Promise<{ events: AuditEvent[]; cursor?: string }> {
    const limit = filter.limit ?? 50;
    if (limit <= 0) {
      return {
        events: [],
        ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      };
    }

    const refs: Record<string, string> = {};
    if (filter.principal !== undefined) refs.subject = filter.principal.subject;
    if (filter.kind !== undefined) refs.kind = filter.kind;
    if (filter.appId !== undefined) refs.app_id = filter.appId;

    const events: AuditEvent[] = [];
    let cursor = filter.cursor;
    let resultCursor: string | undefined;
    const fromInstant = filter.from === undefined ? undefined : Date.parse(filter.from);
    const toInstant = filter.to === undefined ? undefined : Date.parse(filter.to);

    while (events.length < limit) {
      const remaining = limit - events.length;
      const page = await this.#engine.list(AUDIT_COLLECTION, {
        ...(Object.keys(refs).length === 0 ? {} : { refs }),
        limit: remaining,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        const event = auditData(record);
        // Compare instants, not ISO strings: "…00:00:00Z" and "…00:00:00.000Z"
        // are the same moment but sort differently as text, which would drop
        // boundary events from a query/export window.
        const at = Date.parse(event.at);
        if (fromInstant !== undefined && at < fromInstant) continue;
        if (toInstant !== undefined && at > toInstant) continue;
        events.push(event);
      }

      resultCursor = page.cursor;
      if (page.cursor === undefined || page.cursor === cursor) break;
      cursor = page.cursor;
    }

    return {
      events,
      ...(resultCursor === undefined ? {} : { cursor: resultCursor }),
    };
  }

  async *#exportAudit(filter: AuditExportFilter = {}): AsyncIterable<string> {
    // RecordStore pages are newest-first; NDJSON export intentionally preserves that order.
    let cursor: string | undefined;
    do {
      const page = await this.#queryAudit({
        ...filter,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const event of page.events) yield `${JSON.stringify(event)}\n`;
      if (page.cursor === undefined || page.cursor === cursor) break;
      cursor = page.cursor;
    } while (cursor !== undefined);
  }
}

export function createGuard(config: CreateGuardConfig): VendoGuard {
  return new GuardImplementation(config);
}
