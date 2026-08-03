import {
  canonicalJson,
  descriptorHash,
  isUnattended,
  mechanicalRisk,
  projectableForRun,
  resolvedRisk,
  riskLabelSchema,
  withheldFromUnattended,
  sha256Hex,
  toolOutcomeSchema,
  UNATTENDED_DESTRUCTIVE_REASON,
  VendoError,
} from "@vendoai/core";
import type {
  AppId,
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  AuditEvent,
  GrantId,
  GrantScope,
  GuardDecision,
  IsoDateTime,
  Json,
  PermissionGrant,
  Principal,
  RecordQuery,
  RecordStore,
  RunContext,
  StoreAdapter,
  ToolCall,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
  VendoRecord,
} from "@vendoai/core";
import { PolicyResolver, resolvePolicyConfig, ruleMatches } from "./policy.js";
import type {
  CreateGuardConfig,
  Judge,
  PolicyConfigObject,
  PolicyRule,
  VendoGuard,
} from "./types.js";

const GRANTS_COLLECTION = "vendo_grants";
const APPROVALS_COLLECTION = "vendo_approvals";
/** One-time transition receipts for approvals (kill-list B5): `decided:<id>` /
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
/** Build contract §7 — the effect ledger: one row per completed mutating call,
 *  keyed by (run, tool, exact input). It is what makes fail-and-re-run correct:
 *  a re-run of a run that already sent the payment must not send it again. */
const EFFECTS_COLLECTION = "vendo_effects";
const JUDGE_TIMEOUT_MS = 15_000;
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
  blockAlreadyAudited?: boolean;
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
 *  The contract writes the preimage as `runId|turnId`. There is no turn id
 *  anywhere in this codebase, so the run component is `ctx.trigger.runId`.
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
 *  automation fire once and then never again. */
function effectBaseKey(ctx: RunContext, call: ToolCall): string | undefined {
  const runId = ctx.trigger?.runId;
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
  fields: Omit<AuditEvent, "id" | "at" | "principal" | "venue" | "presence" | "appId" | "trigger">,
): AuditEvent {
  return {
    id: makeId("aud_"),
    at: now(),
    principal: ctx.principal,
    venue: ctx.venue,
    presence: ctx.presence,
    ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    ...fields,
  };
}

async function listAll(
  store: RecordStore,
  query: Omit<RecordQuery, "cursor"> = {},
): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await store.list({ ...query, ...(cursor === undefined ? {} : { cursor }) });
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

function scopeMatches(scope: GrantScope, args: unknown): boolean {
  if (scope.kind === "tool") return true;
  return scope.inputHash === exactInputHash(args);
}

function durationMatches(grant: PermissionGrant, ctx: RunContext): boolean {
  if (grant.duration === "standing") return true;
  if (grant.duration === "session") return grant.contextKey === ctx.sessionId;
  return grant.contextKey === (ctx.trigger?.runId ?? ctx.sessionId);
}

function presenceMatches(grant: PermissionGrant, ctx: RunContext): boolean {
  if (ctx.presence === "away") {
    return grant.appId !== undefined && grant.appId === ctx.appId && grant.source === "automation";
  }
  return grant.appId === undefined || grant.appId === ctx.appId;
}

/** Re-gate 2026-07-26 finding 2: a read invoked from the APP venue renders a
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

/** Every write of an approval row derives its refs here, so the index can
 *  never drift from the data. `call` is what keeps the standing-denial lookup
 *  off a subject's whole approval history: chat's random ids simply miss it. */
function approvalRefs(data: ApprovalRecordData): Record<string, string> {
  return {
    subject: data.request.ctx.principal.subject,
    status: data.status,
    call: data.request.call.id,
  };
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
  readonly #store: StoreAdapter;
  /** Per (run, tool, exact input): which ordinal each CALL ID was assigned.
   *  Keyed by call id so a replay of one call reuses its ordinal (and dedupes)
   *  while a second, separately-intended identical call gets the next one. */
  readonly #effectOrdinals = new Map<string, Map<string, number>>();
  /** In-flight execution per effect key, so concurrent identical calls share one
   *  execution instead of both racing past an empty ledger (finding 14). */
  readonly #effectsInFlight = new Map<string, Promise<ToolOutcome>>();
  readonly #config: CreateGuardConfig;
  readonly #policyConfig: PolicyConfigObject | undefined;
  readonly #policy: PolicyResolver;
  readonly #maxCallsPerMinute: number;
  readonly #maxWritesPerRun: number;
  readonly #callWindows = new Map<string, number[]>();
  readonly #writeCounts = new Map<string, { count: number; touchedAt: number }>();
  #lastSweepAt = 0;
  readonly #approvalCallbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

  readonly approvals = {
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
    this.#store = config.store;
    this.#config = config;
    // Compose time, not first call: an unknown preset name (or any other
    // policy misconfiguration `resolvePolicyConfig` catches) must fail loud
    // from `createGuard` itself.
    this.#policyConfig = resolvePolicyConfig(config.policy);
    this.#policy = new PolicyResolver(this.#policyConfig, config.policyCloudFallback);
    this.#maxCallsPerMinute = config.breakers?.maxCallsPerMinute ?? 60;
    this.#maxWritesPerRun = config.breakers?.maxWritesPerRun ?? 20;
  }

  async check(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<GuardDecision> {
    return (await this.#checkWithMetadata(call, descriptor, ctx)).decision;
  }

  /** genqa defect 1 — a preview of `check()`'s verdict for a caller that is
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
    return (await this.#checkWithMetadata(call, descriptor, ctx, false)).decision;
  }

  async report(event: AuditEvent): Promise<void> {
    const normalized: AuditEvent = {
      ...event,
      id: event.id || makeId("aud_"),
      at: event.at || now(),
    };
    const refs: Record<string, string> = {
      subject: normalized.principal.subject,
      kind: normalized.kind,
    };
    if (normalized.appId !== undefined) refs.app_id = normalized.appId;
    if (normalized.tool !== undefined) refs.tool = normalized.tool;
    await this.#store.records(AUDIT_COLLECTION).put({
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

  /** AGENT-6: deny approvals the conversation abandoned. Rides the same
   *  decide path as an explicit denial (audit + callbacks), but is
   *  idempotent: an already-decided (conflict) or unknown/foreign (not-found)
   *  approval already holds the state abandonment wants — only a real store
   *  failure propagates. */
  async abandonApprovals(ids: ApprovalId[], ctx: RunContext): Promise<void> {
    for (const id of ids) {
      try {
        await this.#decideApprovals(id, { approve: false }, ctx.principal, "system");
      } catch (error) {
        if (error instanceof VendoError && (error.code === "conflict" || error.code === "not-found")) {
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
    const record = await this.#store.records(APPROVALS_COLLECTION).get(id);
    if (record === null) return "already-spent";
    const data = approvalData(record);
    if (data.request.ctx.principal.subject !== principal.subject) return "already-spent";
    if (data.status !== "approved" || data.consumedAt !== undefined) return "already-spent";
    if (data.voidedAt !== undefined) return "taken-back";
    return await this.#spendConsumedTransition(id, principal.subject);
  }

  /** Spec 2026-07-20 (#5): the TTL backstop over the general approvals
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
    const records = await listAll(this.#store.records(APPROVALS_COLLECTION));
    let swept = 0;
    for (const record of records) {
      const data = approvalData(record);
      if (data.status !== "pending") continue;
      const parkedAt = Date.parse(data.request.createdAt);
      if (!Number.isFinite(parkedAt) || parkedAt + ttlMs > at) continue;
      try {
        // Deny as the approval's OWN principal — a foreign subject would 404.
        await this.#decideApprovals(record.id, { approve: false }, data.request.ctx.principal, "system");
        swept += 1;
      } catch (error) {
        // Already decided (conflict) or gone (not-found): the queue already
        // holds the state the sweep wants — count nothing, never throw.
        if (error instanceof VendoError && (error.code === "conflict" || error.code === "not-found")) {
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
      descriptors: async (ctx?: Pick<RunContext, "venue" | "presence">) => {
        const all = await tools.descriptors();
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

        const completed = await this.#checkWithMetadata(call, descriptor, ctx);
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
        // redesign (D3) says a tool nobody has graded needs a PERSON — and an
        // unattended venue has none to ask. Without this the merge left a real
        // hole: extraction stopped guessing from names (D1), so Maple's
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
        if (
          decision.action === "run" && !replayApproved
          && isUnattended(ctx) && withheldFromUnattended(completed.descriptor)
        ) {
          const refused: ToolOutcome = { status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON };
          await this.report(
            eventFromContext(ctx, {
              kind: "policy-decision",
              tool: call.tool,
              inputPreview: preview,
              outcome: refused.status,
              decidedBy: "rule",
              detail: {
                reason: "unattended-destructive",
                declaredRisk: completed.descriptor.risk,
                mechanicalRisk: mechanicalRisk(completed.descriptor),
              },
            }),
          );
          return refused;
        }

        if (decision.action === "block") {
          outcome = { status: "blocked", reason: decision.reason };
        } else if (decision.action === "ask") {
          outcome = {
            status: "pending-approval",
            approvalId: decision.approval.id,
          };
        } else {
          const grant = await this.#grantForExecution(decision, call, completed.descriptor, ctx);
          // CORE-2: `grant` is a first-class RunContext field — no cast needed.
          const executeCtx = grant === undefined ? ctx : { ...ctx, grant };
          // Build contract §7: for a MUTATING call, a key that already succeeded
          // returns its recorded outcome INSTEAD of executing. The check sits
          // here, after the guard has said run and before the registry is
          // touched, because that is the only point where skipping is both safe
          // (authority was still checked) and effective (the effect is avoided).
          //
          // `resolvedRisk`, not the declared label: gating on what the model said
          // left the most dangerous class — a destructive tool mislabelled
          // `read` — with no ledger protection at all.
          const resolved = resolvedRisk(completed.descriptor);
          const mutating = resolved === "write" || resolved === "destructive";
          const base = mutating ? effectBaseKey(ctx, call) : undefined;
          const key = base === undefined ? undefined : effectKeyOf(base, this.#effectOrdinal(base, call.id));
          const recorded = key === undefined ? undefined : await this.#recordedEffect(key);
          if (recorded !== undefined) {
            outcome = recorded;
          } else {
            // Finding 14 (TOCTOU): two concurrent identical calls both read "no
            // receipt" and both executed. Share one in-flight execution per key
            // so the second awaits the first's outcome instead of repeating it.
            const inFlight = key === undefined ? undefined : this.#effectsInFlight.get(key);
            if (inFlight !== undefined) {
              outcome = await inFlight;
            } else {
              const run = (async (): Promise<ToolOutcome> => {
                try {
                  return await tools.execute(call, executeCtx);
                } catch (error) {
                  return {
                    status: "error",
                    error: {
                      code: error instanceof VendoError ? error.code : "error",
                      message: errorMessage(error),
                    },
                  };
                }
              })();
              if (key !== undefined) this.#effectsInFlight.set(key, run);
              try {
                outcome = await run;
              } finally {
                if (key !== undefined) this.#effectsInFlight.delete(key);
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
                  console.error(
                    `[vendo] guard: ${call.tool} completed but its effect receipt could not be written `
                    + `(${errorMessage(error)}). A re-run of this run may repeat the call.`,
                  );
                }
              }
            }
          }
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

  status(): { posture: "unconfigured" | "rules" | "judge" | "rules+judge" } {
    const hasRules = this.#policyConfig !== undefined;
    const hasJudge = this.#config.judge !== undefined;
    if (hasRules && hasJudge) return { posture: "rules+judge" };
    if (hasRules) return { posture: "rules" };
    if (hasJudge) return { posture: "judge" };
    return { posture: "unconfigured" };
  }

  /**
   * genqa defect 1 (double-count): a "run" verdict here mutates the call-rate
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
   * preview is never the one who gets to spend the budget — the very next
   * real check (moments later, same call) does that once, for real. A
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
    const effectiveDescriptor = await this.#effectiveDescriptor(call, descriptor, ctx);
    const callsTripped = commitRun
      ? this.#recordCall(ctx.principal.subject)
      : this.#peekCallsTripped(ctx.principal.subject);
    const metadata = await this.#pipeline(call, effectiveDescriptor, ctx);
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

    if (draft.action === "block" && !metadata.blockAlreadyAudited) {
      await this.report(
        eventFromContext(ctx, {
          kind: "policy-decision",
          tool: call.tool,
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
      console.warn(
        `[vendo] guard: org policy could not be resolved (${errorMessage(error)}) — no org rules were `
        + `applied to ${call.tool}. Host policy and user approvals still decided it.`,
      );
      await this.report(
        eventFromContext(ctx, {
          kind: "policy-decision",
          tool: call.tool,
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
      const resolved = riskLabelSchema.safeParse(await resolveRisk(call, descriptor, ctx));
      if (!resolved.success) return descriptor;
      return resolved.data === descriptor.risk ? descriptor : { ...descriptor, risk: resolved.data };
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
   * Bounds the in-memory breaker maps (they would otherwise grow one entry per
   * subject / run key for process lifetime). Runs at most once per minute,
   * piggybacked on check traffic. Consequence, documented: a run idle longer
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
  }

  async #pipeline(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<DecisionMetadata> {
    // An exact approved replay answers a confirmEach ask (05 §2 stays otherwise:
    // grants/rules/judge never suppress confirmEach).
    let consumedReplay = false;
    if (descriptor.confirmEach === true) {
      consumedReplay = await this.#consumeApprovedCall(call, descriptor, ctx);
      if (!consumedReplay) {
        return { decision: { action: "ask", decidedBy: "confirmEach" } };
      }
    }

    if (consumedReplay || await this.#consumeApprovedCall(call, descriptor, ctx)) {
      return { decision: { action: "run", decidedBy: "grant" } };
    }

    const { grant, invalidated } = await this.#matchingGrant(call, descriptor, ctx);
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

    // Nothing spoke. An `ungraded` tool is one nobody has graded — no human,
    // no judge, no protocol fact — so not-knowing is felt here rather than
    // hidden behind a run: it asks, exactly as `destructive` does under the
    // default policy. Guard-level on purpose, so a hand-wired server with no
    // policy config at all gets it too. A host that consciously wants these to
    // run says so in writing, with a `risk: "ungraded"` rule.
    if (descriptor.risk === "ungraded") {
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

  /** The grant that authorized a "run", re-attached for executors that need it
   *  (actions resolves ActAs against ctx.grant on away calls — 04 §4). Approval
   *  replays carry no grantId; away replays re-match, because deciding a parked
   *  automation approval mints the app-bound grant first (07 §3). */
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
    const record = await this.#store.records(EFFECTS_COLLECTION).get(key);
    if (record === null) return undefined;
    const outcome = (record.data as { outcome?: unknown }).outcome;
    const parsed = toolOutcomeSchema.safeParse(outcome);
    // A row we cannot read is treated as absent: refusing to execute on the
    // strength of an unparseable receipt would strand the call forever.
    return parsed.success ? parsed.data : undefined;
  }

  /** Write the receipt. `insertIfAbsent` where the adapter offers it, so a racing
   *  writer cannot overwrite an already-recorded outcome.
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
    const records = this.#store.records(EFFECTS_COLLECTION);
    const input = {
      id: key,
      data: { subject, outcome: cloneJson(outcome) as Json, at: now() },
      refs: { subject },
    };
    if (records.atomic === undefined) await records.put(input);
    else await records.atomic.insertIfAbsent(input);
  }

  async #grantForExecution(
    decision: GuardDecision,
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<PermissionGrant | undefined> {
    if (decision.action !== "run") return undefined;
    if (decision.grantId !== undefined) {
      const record = await this.#store.records(GRANTS_COLLECTION).get(decision.grantId);
      return record === null ? undefined : (record.data as PermissionGrant);
    }
    if (ctx.presence !== "away") return undefined;
    return (await this.#matchingGrant(call, descriptor, ctx)).grant;
  }

  /** Wins (or loses) an approval's one-time transition by inserting its
   *  receipt through the store's atomic `insertIfAbsent` — a single statement,
   *  so exactly one claimant succeeds no matter how many processes race. Fails
   *  closed when the adapter omits the capability: single-use state cannot be
   *  guaranteed without database-level CAS (02-store §4).
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
    const atomic = this.#store.records(APPROVAL_CLAIMS_COLLECTION).atomic;
    if (atomic === undefined) {
      throw new VendoError(
        "not-implemented",
        "approvals need a store with the atomic-revisions capability (RecordStore.atomic, 02-store §4); this adapter omits it, so single-use approval transitions fail closed",
      );
    }
    const receipt = await atomic.insertIfAbsent({
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
    const receipt = await this.#store.records(APPROVAL_CLAIMS_COLLECTION).get(`consumed:${approvalId}`);
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
   * erasure (02-store §5) and anonymous-subject adoption both DELETE approval
   * rows, and re-putting the caller's stale copy would resurrect an erased
   * subject's approval AND run the tool as them — and a void that beat the
   * claim, which must not be overwritten. Hence the re-read.
   */
  async #spendConsumedTransition(
    id: string,
    subject: string,
  ): Promise<"spent" | "already-spent" | "taken-back"> {
    if (!(await this.#claimApprovalTransition("consumed", id, subject, "replay"))) {
      return (await this.#consumedTransitionClaimant(id)) === "void" ? "taken-back" : "already-spent";
    }
    const store = this.#store.records(APPROVALS_COLLECTION);
    const current = await store.get(id);
    if (current === null) return "already-spent";
    const fresh = approvalData(current);
    if (fresh.voidedAt !== undefined) return "taken-back";
    const spent: ApprovalRecordData = { ...fresh, consumedAt: now() };
    await store.put({ id, data: spent, refs: approvalRefs(spent) });
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
    const store = this.#store.records(APPROVALS_COLLECTION);
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
    // that is GONE was erased (02-store §5) or dropped by anon-adoption while
    // this was in flight; re-putting it would resurrect erased data, so there is
    // nothing left to void.
    const current = await store.get(id);
    if (current === null) return "already-void";
    const fresh = approvalData(current);
    // The take-back this call is retrying already landed: nothing to say twice.
    if (!claimed && fresh.voidedAt !== undefined) return "already-void";
    const voided: ApprovalRecordData = { ...fresh, voidedAt: fresh.voidedAt ?? now() };
    await store.put({ id, data: voided, refs: approvalRefs(voided) });
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
    const records = this.#store.records(APPROVAL_CLAIMS_COLLECTION);
    for (const approvalId of approvalIds) {
      try {
        await records.delete(`${transition}:${approvalId}`);
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
    const records = await listAll(this.#store.records(APPROVALS_COLLECTION), {
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

  async #consumeApprovedCall(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<boolean> {
    const fingerprint = descriptorHash(descriptor);
    const store = this.#store.records(APPROVALS_COLLECTION);
    const records = await listAll(store, {
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
    const records = await listAll(this.#store.records(GRANTS_COLLECTION), {
      refs: { subject: ctx.principal.subject },
    });
    const fingerprint = descriptorHash(descriptor);
    const at = Date.now();
    const invalidated: PermissionGrant[] = [];

    for (const record of records) {
      const grant = grantData(record);
      const expiresAt = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt);
      if (grant.subject !== ctx.principal.subject) continue;
      if (grant.tool !== call.tool) continue;
      if (grant.revokedAt !== undefined) continue;
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= at)) continue;
      if (!durationMatches(grant, ctx) || !presenceMatches(grant, ctx)) continue;
      if (!scopeMatches(grant.scope, call.args)) continue;
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
    await this.#store.records(APPROVALS_COLLECTION).put({ id: request.id, data, refs: approvalRefs(data) });
    return request;
  }

  async #pendingApprovals(principal: Principal): Promise<ApprovalRequest[]> {
    const records = await listAll(this.#store.records(APPROVALS_COLLECTION), {
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
    const store = this.#store.records(APPROVALS_COLLECTION);
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
      const record = await store.get(id);
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
    const store = this.#store.records(APPROVALS_COLLECTION);
    const fingerprint = descriptorHash(denied.request.descriptor);
    const siblings = await listAll(store, {
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
    const store = this.#store.records(APPROVALS_COLLECTION);
    const decidedAt = now();
    const status = decision.approve ? "approved" : "denied";
    const entry: { id: string; prior: ReturnType<typeof approvalData>; grantId?: GrantId } = { id, prior: data };
    const decided: ApprovalRecordData = {
      ...data,
      status,
      decidedAt,
      ...(decision.approve ? {} : { deniedBy: provenance }),
    };
    await store.put({ id, data: decided, refs: approvalRefs(decided) });
    applied.push(entry);
    if (!decision.approve && provenance === "human") await this.#supersedeApprovedSiblings(decided);

    let grant: PermissionGrant | undefined;
    if (decision.approve && decision.remember !== undefined) {
      const duration = decision.remember.duration;
      grant = {
        id: makeId("grt_") as GrantId,
        subject: principal.subject,
        tool: data.request.call.tool,
        descriptorHash: descriptorHash(data.request.descriptor),
        scope: normalizeRememberedScope(decision.remember.scope, data.request),
        duration,
        ...(duration === "session"
          ? { contextKey: data.sessionId }
          : duration === "task"
            ? { contextKey: data.request.ctx.trigger?.runId ?? data.sessionId }
            : {}),
        ...(data.request.ctx.appId === undefined ? {} : { appId: data.request.ctx.appId }),
        source: batch ? "batch" : "chat",
        grantedAt: decidedAt,
      };
      const refs: Record<string, string> = {
        subject: grant.subject,
        tool: grant.tool,
      };
      if (grant.appId !== undefined) refs.app_id = grant.appId;
      await this.#store.records(GRANTS_COLLECTION).put({
        id: grant.id,
        data: grant,
        refs,
      });
      entry.grantId = grant.id;
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
        ...(grant === undefined ? {} : { grantId: grant.id }),
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
    const store = this.#store.records(APPROVALS_COLLECTION);
    let rollbackFailed = false;
    for (const member of [...applied].reverse()) {
      try {
        if (member.grantId !== undefined) {
          await this.#store.records(GRANTS_COLLECTION).delete(member.grantId);
        }
        // Restore only a row nothing else has acted on. In the ms between this
        // member's commit and a LATER member's store failure, a concurrent
        // replay can spend it and a take-back can void it — and both of those
        // transitions are single-use, so re-opening the ask would advertise a
        // decision no one can make again and erase the marker of what did
        // happen. A gone row was erased (02-store §5) and must never be
        // re-created here. Both cases leave the member decided, which its own
        // audit line already says; the retry then reads it as decided.
        const current = await store.get(member.id);
        if (current === null) continue;
        const live = approvalData(current);
        if (live.consumedAt !== undefined || live.voidedAt !== undefined) continue;
        await store.put({ id: member.id, data: member.prior, refs: approvalRefs(member.prior) });
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
    const records = await listAll(this.#store.records(GRANTS_COLLECTION), {
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
    const store = this.#store.records(APPROVALS_COLLECTION);
    const record = await store.get(id);
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
    const store = this.#store.records(GRANTS_COLLECTION);
    const record = await store.get(id);
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
    await store.put({ id, data: revoked, refs });
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
    const store = this.#store.records(AUDIT_COLLECTION);
    let cursor = filter.cursor;
    let resultCursor: string | undefined;
    const fromInstant = filter.from === undefined ? undefined : Date.parse(filter.from);
    const toInstant = filter.to === undefined ? undefined : Date.parse(filter.to);

    while (events.length < limit) {
      const remaining = limit - events.length;
      const page = await store.list({
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
