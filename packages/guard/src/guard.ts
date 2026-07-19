import {
  canonicalJson,
  descriptorHash,
  sha256Hex,
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
  VendoGuard,
} from "./types.js";

const GRANTS_COLLECTION = "vendo_grants";
const APPROVALS_COLLECTION = "vendo_approvals";
/** One-time transition receipts for approvals (kill-list B5): `decided:<id>` /
 *  `consumed:<id>` rows in a guard-owned generic collection, written only via
 *  the store's atomic `insertIfAbsent` (02-store §4) so exactly one caller —
 *  across processes — wins each transition. Rows carry `refs.subject`, so the
 *  02-store §5 erase cascade collects them with the rest of the subject's data. */
const APPROVAL_CLAIMS_COLLECTION = "guard:approval-claims";
const AUDIT_COLLECTION = "vendo_audit";
const JUDGE_TIMEOUT_MS = 15_000;

interface ApprovalRecordData {
  request: ApprovalRequest;
  status: "pending" | "approved" | "denied";
  decidedAt?: IsoDateTime;
  sessionId: string;
  consumedAt?: IsoDateTime;
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

function normalizeCodeDecision(decision: GuardDecision): DraftDecision {
  // The policy-code stage cannot self-attribute its provenance. `policy.code` is
  // deploy-time host code, not the user's real-time consent, so it must never be
  // able to return `decidedBy: "grant"` — that label is reserved for an actual
  // app-bound PermissionGrant and is the ONLY "run" the away-downgrade gate
  // (05 §6) exempts from parking. Forcing every code decision to "rule" (and
  // dropping any code-supplied grantId) makes a code-sourced run behave exactly
  // like a rule-sourced run: away-downgraded to a park, and honestly attributed
  // in the audit trail. This mirrors how code ERRORS already fail to "rule".
  if (decision.action === "run") {
    return { action: "run", decidedBy: "rule" };
  }
  if (decision.action === "ask") {
    return { action: "ask", decidedBy: "rule" };
  }
  return {
    action: "block",
    reason: decision.reason,
    decidedBy: "rule",
  };
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
    ): Promise<void> => this.#decideApprovals(ids, decision, principal),
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
    this.#policy = new PolicyResolver(this.#policyConfig);
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
        await this.#decideApprovals(id, { approve: false }, ctx.principal);
      } catch (error) {
        if (error instanceof VendoError && (error.code === "conflict" || error.code === "not-found")) {
          continue;
        }
        throw error;
      }
    }
  }

  bind(tools: ToolRegistry): ToolRegistry {
    return {
      descriptors: () => tools.descriptors(),
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
          try {
            outcome = await tools.execute(call, executeCtx);
          } catch (error) {
            outcome = {
              status: "error",
              error: {
                code: error instanceof VendoError ? error.code : "error",
                message: errorMessage(error),
              },
            };
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

  async #checkWithMetadata(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<CompletedDecision> {
    const effectiveDescriptor = await this.#effectiveDescriptor(call, descriptor, ctx);
    const callsTripped = this.#recordCall(ctx.principal.subject);
    const metadata = await this.#pipeline(call, effectiveDescriptor, ctx);
    let draft = metadata.decision;

    // 05 §6: away runs hold only grants captured while present and bound to the
    // running app — a would-be "run" that is not grant-authorized (rule, code,
    // judge, or the default posture) parks instead of running.
    if (ctx.presence === "away" && draft.action === "run" && draft.decidedBy !== "grant") {
      draft = { action: "ask", decidedBy: "default" };
    }

    if (draft.action === "run") {
      const write = effectiveDescriptor.risk === "write" || effectiveDescriptor.risk === "destructive";
      const runKey = ctx.trigger?.runId ?? ctx.sessionId;
      const writes = this.#writeCounts.get(runKey)?.count ?? 0;
      const writesTripped = write && writes >= this.#maxWritesPerRun;

      if (callsTripped || writesTripped) {
        draft = { action: "ask", decidedBy: "breaker" };
      } else if (write) {
        this.#writeCounts.set(runKey, { count: writes + 1, touchedAt: Date.now() });
      }
    }

    if (draft.action === "ask") {
      const invalidated = metadata.invalidatedGrants ?? [];
      const approval = await this.#parkApproval(call, effectiveDescriptor, ctx, invalidated[0]);
      const decision: GuardDecision = {
        action: "ask",
        approval,
        decidedBy: draft.decidedBy,
      };
      if (invalidated.length > 0) {
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

    if (draft.action === "block") {
      if (!metadata.blockAlreadyAudited) {
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
      const decision: GuardDecision = draft;
      return {
        decision,
        descriptor: effectiveDescriptor,
        ...(metadata.rationale === undefined ? {} : { rationale: metadata.rationale }),
      };
    }

    return {
      decision: draft,
      descriptor: effectiveDescriptor,
      ...(metadata.rationale === undefined ? {} : { rationale: metadata.rationale }),
    };
  }

  async #effectiveDescriptor(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<ToolDescriptor> {
    const resolveRisk = this.#config.resolveRisk;
    if (resolveRisk === undefined) return descriptor;
    try {
      const risk = await resolveRisk(call, descriptor, ctx);
      if (risk !== "read" && risk !== "write" && risk !== "destructive") return descriptor;
      return risk === descriptor.risk ? descriptor : { ...descriptor, risk };
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
    // An exact approved replay answers a critical ask (05 §2 stays otherwise:
    // grants/rules/judge never suppress critical).
    let consumedReplay = false;
    if (descriptor.critical === true) {
      consumedReplay = await this.#consumeApprovedCall(call, descriptor, ctx);
      if (!consumedReplay) {
        return { decision: { action: "ask", decidedBy: "critical" } };
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
      if (rule.action === "run") {
        return withInvalidated({ decision: { action: "run", decidedBy: "rule" } });
      }
      if (rule.action === "ask") {
        return withInvalidated({ decision: { action: "ask", decidedBy: "rule" } });
      }
      return withInvalidated({
        decision: {
          action: "block",
          reason: rule.note ?? "blocked by policy rule",
          decidedBy: "rule",
        },
      });
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
        if (judged.action === "run") {
          return withInvalidated({
            decision: { action: "run", decidedBy: "judge" },
            rationale: judged.rationale,
          });
        }
        if (judged.action === "ask") {
          return withInvalidated({
            decision: { action: "ask", decidedBy: "judge" },
            rationale: judged.rationale,
          });
        }
        return withInvalidated({
          decision: {
            action: "block",
            reason: judged.rationale,
            decidedBy: "judge",
          },
          rationale: judged.rationale,
        });
      } catch (error) {
        return withInvalidated({
          decision: { action: "ask", decidedBy: "judge" },
          rationale: errorMessage(error),
        });
      }
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
   *  guaranteed without database-level CAS (02-store §4). */
  async #claimApprovalTransition(
    transition: "decided" | "consumed",
    approvalId: string,
    subject: string,
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
      data: { approvalId, transition, at: now() },
      refs: { subject },
    });
    return receipt !== null;
  }

  async #consumeApprovedCall(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<boolean> {
    const fingerprint = descriptorHash(descriptor);
    const store = this.#store.records(APPROVALS_COLLECTION);
    const records = await listAll(store, {
      refs: { subject: ctx.principal.subject, status: "approved" },
    });
    for (const record of records) {
      const data = approvalData(record);
      const request = data.request;
      // A single-use approval re-authorizes exactly the call the user saw, in
      // exactly the context they saw it. Beyond subject + call identity this
      // pins (a) the approved inputs — a replay with tampered args never rides
      // the approval — (b) the frozen descriptor — flipping the same tool from
      // read to destructive after parking can't ride it either — and (c) the
      // parked venue/presence/app — a present chat approval can't be replayed
      // to satisfy an away, app-bound automation call.
      if (
        data.status !== "approved" ||
        data.consumedAt !== undefined ||
        request.ctx.principal.subject !== ctx.principal.subject ||
        request.call.id !== call.id ||
        request.call.tool !== call.tool ||
        exactInputHash(request.call.args) !== exactInputHash(call.args) ||
        descriptorHash(request.descriptor) !== fingerprint ||
        request.ctx.venue !== ctx.venue ||
        request.ctx.presence !== ctx.presence ||
        request.ctx.appId !== ctx.appId
      ) {
        continue;
      }
      // Single-use is enforced by the receipt, not by the consumedAt read
      // above (that check is only a fast path): the atomic insert has exactly
      // one winner across processes. A loser falls through to the next
      // candidate — the same approved call parked twice yields two approvals,
      // each replayable once, exactly as before.
      if (!(await this.#claimApprovalTransition("consumed", record.id, ctx.principal.subject))) {
        continue;
      }
      // Observability marker on the row itself; the receipt is the source of
      // truth, so a crash between the two writes fails closed (the approval
      // reads un-consumed but can never be claimed again).
      await store.put({
        id: record.id,
        data: { ...data, consumedAt: now() },
        refs: { subject: ctx.principal.subject, status: "approved" },
      });
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
    await this.#store.records(APPROVALS_COLLECTION).put({
      id: request.id,
      data,
      refs: { subject: ctx.principal.subject, status: "pending" },
    });
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
  ): Promise<void> {
    const normalizedIds = Array.isArray(ids) ? ids : [ids];
    const store = this.#store.records(APPROVALS_COLLECTION);

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
        throw new VendoError("conflict", `Approval ${id} has already been decided`);
      }
      // pending → decided happens once: the receipt's atomic insert picks a
      // single winner, so a concurrent approve and deny can never both act —
      // no contradictory audit records, and no live grant minted for an
      // approval whose stored status says denied. The loser reports the same
      // conflict a late decider sees.
      if (!(await this.#claimApprovalTransition("decided", id, principal.subject))) {
        throw new VendoError("conflict", `Approval ${id} has already been decided`);
      }
      const decidedAt = now();
      const status = decision.approve ? "approved" : "denied";
      await store.put({
        id,
        data: { ...data, status, decidedAt },
        refs: { subject: principal.subject, status },
      });

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
          source: normalizedIds.length > 1 ? "batch" : "chat",
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

      // A subscriber may re-enter the guard (e.g. re-execute the resumed
      // call), so callbacks fire only after this approval's writes landed.
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

  async #listGrants(principal: Principal): Promise<PermissionGrant[]> {
    const records = await listAll(this.#store.records(GRANTS_COLLECTION), {
      refs: { subject: principal.subject },
    });
    return records
      .map(grantData)
      .filter((grant) => grant.subject === principal.subject);
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

    while (events.length < limit) {
      const remaining = limit - events.length;
      const page = await store.list({
        ...(Object.keys(refs).length === 0 ? {} : { refs }),
        limit: remaining,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const fromInstant = filter.from === undefined ? undefined : Date.parse(filter.from);
      const toInstant = filter.to === undefined ? undefined : Date.parse(filter.to);
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
