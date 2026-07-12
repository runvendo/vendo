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
import { PolicyResolver, ruleMatches } from "./policy.js";
import type {
  CreateGuardConfig,
  Judge,
  PolicyConfig,
  Scanner,
  VendoGuard,
} from "./types.js";

const GRANTS_COLLECTION = "vendo_grants";
const APPROVALS_COLLECTION = "vendo_approvals";
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
}

interface CompletedDecision {
  decision: GuardDecision;
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

/**
 * Serializes state transitions on the approval queue within one process. The
 * StoreAdapter seam exposes no compare-and-set, so concurrent guard operations
 * (a single-use consume racing itself, or approve racing deny on the same row)
 * would otherwise both observe a stale `pending`/un-consumed row and both act.
 * A promise chain closes that window for the single-process durability model
 * these blocks assume; a multi-process store owns cross-process atomicity.
 */
class AsyncLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
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

/**
 * Rejects `matches` constraint patterns that can backtrack catastrophically:
 * oversize patterns, backreferences, and a quantifier applied to a group that
 * itself contains a quantifier (the classic exponential shape). The check is
 * deliberately fail-safe — odd-but-safe patterns may be rejected; rewrite them.
 * Enforced at grant-mint time (loud validation error) AND match time (fails
 * the constraint) so pre-existing stored grants can't smuggle one in.
 */
function isUnsafeMatchPattern(pattern: string): boolean {
  if (pattern.length > 256) return true;
  if (/\\[1-9]/.test(pattern)) return true;
  return /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:[*+?]|\{\d+(?:,\d*)?\})/.test(
    pattern,
  );
}

function resolvePointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value };
  if (!pointer.startsWith("/")) return { found: false };

  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return { found: false };
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false };
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

function scopeMatches(scope: GrantScope, args: unknown): boolean {
  if (scope.kind === "tool") return true;
  if (scope.kind === "exact") return scope.inputHash === exactInputHash(args);

  // Fail closed on an empty constraints array: `every` over nothing is `true`,
  // which would silently authorize ANY args — a tool-wide wildcard wearing a
  // "constrained" label the preview implies is narrow. Mint-time validation
  // rejects this shape too (#decideApprovals), but a pre-existing or injected
  // stored grant must never authorize on the strength of zero constraints.
  if (scope.constraints.length === 0) return false;

  return scope.constraints.every((constraint) => {
    const resolved = resolvePointer(args, constraint.path);
    if (!resolved.found) return false;

    switch (constraint.op) {
      case "eq":
        return resolved.value === constraint.value;
      case "lte":
        return (
          typeof resolved.value === "number" &&
          typeof constraint.value === "number" &&
          resolved.value <= constraint.value
        );
      case "gte":
        return (
          typeof resolved.value === "number" &&
          typeof constraint.value === "number" &&
          resolved.value >= constraint.value
        );
      case "matches":
        if (typeof resolved.value !== "string" || typeof constraint.value !== "string") {
          return false;
        }
        // ReDoS bounds: an adversarial pattern or oversized input fails the
        // constraint instead of stalling the guard process. Length caps alone
        // don't stop catastrophic backtracking ("^(a+)+$" is 8 chars), so
        // exponential-blowup shapes are rejected outright.
        if (isUnsafeMatchPattern(constraint.value) || resolved.value.length > 1024) return false;
        try {
          return new RegExp(constraint.value).test(resolved.value);
        } catch {
          return false;
        }
    }
  });
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
  readonly #policy: PolicyResolver;
  readonly #scanners: Scanner[];
  readonly #maxCallsPerMinute: number;
  readonly #maxWritesPerRun: number;
  readonly #callWindows = new Map<string, number[]>();
  readonly #writeCounts = new Map<string, { count: number; touchedAt: number }>();
  #lastSweepAt = 0;
  readonly #approvalCallbacks = new Set<(id: ApprovalId, approved: boolean) => void>();
  readonly #approvalLock = new AsyncLock();

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
    this.#policy = new PolicyResolver(config.policy);
    this.#scanners = config.scanners ?? [];
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
          const grant = await this.#grantForExecution(decision, call, descriptor, ctx);
          const executeCtx =
            grant === undefined ? ctx : ({ ...ctx, grant } as RunContext & { grant: PermissionGrant });
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

          if (outcome.status === "ok") {
            outcome = await this.#scanOutput(outcome, call, ctx);
          }
        }

        const detail: Record<string, unknown> = {};
        if (decision.decidedBy === "judge" && completed.rationale !== undefined) {
          detail.rationale = completed.rationale;
        }
        if (decision.action === "run" && decision.grantId !== undefined) {
          detail.grantId = decision.grantId;
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
    const hasRules = this.#config.policy !== undefined;
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
    const callsTripped = this.#recordCall(ctx.principal.subject);
    const metadata = await this.#pipeline(call, descriptor, ctx);
    let draft = metadata.decision;

    // 05 §6: away runs hold only grants captured while present and bound to the
    // running app — a would-be "run" that is not grant-authorized (rule, code,
    // judge, or the default posture) parks instead of running.
    if (ctx.presence === "away" && draft.action === "run" && draft.decidedBy !== "grant") {
      draft = { action: "ask", decidedBy: "default" };
    }

    if (draft.action === "run") {
      const write = descriptor.risk === "write" || descriptor.risk === "destructive";
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
      const approval = await this.#parkApproval(call, descriptor, ctx);
      const decision: GuardDecision = {
        action: "ask",
        approval,
        decidedBy: draft.decidedBy,
      };
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
        ...(metadata.rationale === undefined ? {} : { rationale: metadata.rationale }),
      };
    }

    return {
      decision: draft,
      ...(metadata.rationale === undefined ? {} : { rationale: metadata.rationale }),
    };
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
    // grants/rules/judge never suppress critical) — but scanners still get the
    // call below. If a scanner then blocks, the single-use approval is already
    // consumed: burning it on a blocked call fails closed.
    let consumedReplay = false;
    if (descriptor.critical === true) {
      consumedReplay = await this.#consumeApprovedCall(call, descriptor, ctx);
      if (!consumedReplay) {
        return { decision: { action: "ask", decidedBy: "critical" } };
      }
    }

    const scannerDecision = await this.#scanInput(call, ctx);
    if (scannerDecision !== undefined) return scannerDecision;

    if (consumedReplay || await this.#consumeApprovedCall(call, descriptor, ctx)) {
      return { decision: { action: "run", decidedBy: "grant" } };
    }

    const grant = await this.#matchingGrant(call, descriptor, ctx);
    if (grant !== undefined) {
      return {
        decision: {
          action: "run",
          decidedBy: "grant",
          grantId: grant.id,
        },
      };
    }

    const rules = await this.#policy.rules();
    for (const rule of rules) {
      if (!ruleMatches(rule, call.tool, descriptor.risk, ctx.venue, ctx.presence)) continue;
      if (rule.action === "run") {
        return { decision: { action: "run", decidedBy: "rule" } };
      }
      if (rule.action === "ask") {
        return { decision: { action: "ask", decidedBy: "rule" } };
      }
      return {
        decision: {
          action: "block",
          reason: rule.note ?? "blocked by policy rule",
          decidedBy: "rule",
        },
      };
    }

    const code = this.#config.policy?.code;
    if (code !== undefined) {
      try {
        const decision = code(call, descriptor, ctx);
        if (decision !== undefined) return { decision: normalizeCodeDecision(decision) };
      } catch (error) {
        return {
          decision: { action: "ask", decidedBy: "rule" },
          rationale: errorMessage(error),
        };
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
          return {
            decision: { action: "run", decidedBy: "judge" },
            rationale: judged.rationale,
          };
        }
        if (judged.action === "ask") {
          return {
            decision: { action: "ask", decidedBy: "judge" },
            rationale: judged.rationale,
          };
        }
        return {
          decision: {
            action: "block",
            reason: judged.rationale,
            decidedBy: "judge",
          },
          rationale: judged.rationale,
        };
      } catch (error) {
        return {
          decision: { action: "ask", decidedBy: "judge" },
          rationale: errorMessage(error),
        };
      }
    }

    return { decision: { action: "run", decidedBy: "default" } };
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

  async #scanInput(call: ToolCall, ctx: RunContext): Promise<DecisionMetadata | undefined> {
    const text = canonicalJson(call.args);
    for (const scanner of this.#scanners) {
      if (scanner.on !== "input") continue;
      try {
        const result = await scanner.scan({ text, call, ctx });
        if (result.verdict === "ok") continue;
        const findings = result.findings ?? [];
        await this.#reportScannerFinding(scanner.name, findings, call, ctx, result.verdict);
        if (result.verdict === "block") {
          return {
            decision: {
              action: "block",
              reason: findings.join("; ") || `${scanner.name} blocked input`,
              decidedBy: "scanner",
            },
            blockAlreadyAudited: true,
          };
        }
      } catch (error) {
        await this.#reportScannerFinding(
          scanner.name,
          [errorMessage(error)],
          call,
          ctx,
          "flag",
        );
      }
    }
    return undefined;
  }

  async #scanOutput(
    original: Extract<ToolOutcome, { status: "ok" }>,
    call: ToolCall,
    ctx: RunContext,
  ): Promise<ToolOutcome> {
    if (!this.#scanners.some((scanner) => scanner.on === "output")) return original;
    const text = canonicalJson(original.output);
    for (const scanner of this.#scanners) {
      if (scanner.on !== "output") continue;
      try {
        const result = await scanner.scan({ text, call, ctx });
        if (result.verdict === "ok") continue;
        const findings = result.findings ?? [];
        await this.#reportScannerFinding(scanner.name, findings, call, ctx, result.verdict);
        if (result.verdict === "block") {
          return {
            status: "blocked",
            reason: findings.join("; ") || `${scanner.name} blocked output`,
          };
        }
      } catch (error) {
        await this.#reportScannerFinding(
          scanner.name,
          [errorMessage(error)],
          call,
          ctx,
          "flag",
        );
      }
    }
    return original;
  }

  async #reportScannerFinding(
    scanner: string,
    findings: string[],
    call: ToolCall,
    ctx: RunContext,
    verdict: "flag" | "block",
  ): Promise<void> {
    await this.report(
      eventFromContext(ctx, {
        kind: "policy-decision",
        tool: call.tool,
        inputPreview: inputPreview(call),
        ...(verdict === "block" ? { outcome: "blocked" as const } : {}),
        decidedBy: "scanner",
        detail: { scanner, findings },
      }),
    );
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
    return this.#matchingGrant(call, descriptor, ctx);
  }

  async #consumeApprovedCall(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<boolean> {
    const fingerprint = descriptorHash(descriptor);
    // Claim under the lock: the find and the consuming put must be one
    // indivisible step, or two concurrent executes of the same approved call
    // both see no consumedAt and both run.
    return this.#approvalLock.run(async () => {
      const store = this.#store.records(APPROVALS_COLLECTION);
      const records = await listAll(store, {
        refs: { subject: ctx.principal.subject, status: "approved" },
      });
      for (const record of records) {
        const data = approvalData(record);
        const request = data.request;
        // A single-use approval re-authorizes exactly the call the user saw, in
        // exactly the context they saw it. Beyond subject + call identity this
        // pins (a) the frozen descriptor — so flipping the same tool from read
        // to destructive after parking can't ride the approval — and (b) the
        // parked venue/presence/app — so a present chat approval can't be
        // replayed to satisfy an away, app-bound automation call.
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
        await store.put({
          id: record.id,
          data: { ...data, consumedAt: now() },
          refs: { subject: ctx.principal.subject, status: "approved" },
        });
        return true;
      }
      return false;
    });
  }

  async #matchingGrant(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<PermissionGrant | undefined> {
    const records = await listAll(this.#store.records(GRANTS_COLLECTION), {
      refs: { subject: ctx.principal.subject },
    });
    const fingerprint = descriptorHash(descriptor);
    const at = Date.now();

    for (const record of records) {
      const grant = grantData(record);
      const expiresAt = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt);
      if (grant.subject !== ctx.principal.subject) continue;
      if (grant.tool !== call.tool || grant.descriptorHash !== fingerprint) continue;
      if (grant.revokedAt !== undefined) continue;
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= at)) continue;
      if (!durationMatches(grant, ctx) || !presenceMatches(grant, ctx)) continue;
      if (!scopeMatches(grant.scope, call.args)) continue;
      return grant;
    }
    return undefined;
  }

  async #parkApproval(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: makeId("apr_") as ApprovalId,
      call: cloneJson(call),
      descriptor: cloneJson(descriptor),
      inputPreview: inputPreview(call),
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
      // The read-validate-write for one approval must be atomic: without the
      // lock a concurrent approve and deny both observe the same `pending` row,
      // yielding contradictory audit records and — worse — a live grant even
      // when deny wins the stored status.
      await this.#approvalLock.run(async () => {
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
        if (decision.approve && decision.remember?.scope.kind === "constrained") {
          // Validate BEFORE any state changes: a rejected remember must not leave
          // the approval half-decided.
          if (decision.remember.scope.constraints.length === 0) {
            // An empty constraints array makes `scopeMatches` an
            // every()-over-nothing → true: a tool-wide wildcard masquerading as
            // the narrow "constrained" grant the preview implies. Reject it.
            throw new VendoError(
              "validation",
              "A constrained grant must declare at least one constraint",
            );
          }
          for (const constraint of decision.remember.scope.constraints) {
            if (
              constraint.op === "matches" &&
              (typeof constraint.value !== "string" || isUnsafeMatchPattern(constraint.value))
            ) {
              throw new VendoError(
                "validation",
                `Grant constraint pattern for ${constraint.path} is not a safe regular expression`,
              );
            }
          }
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
      });

      // Fire callbacks OUTSIDE the lock: a subscriber may re-enter the guard
      // (e.g. re-execute the resumed call), which would deadlock on the lock.
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

export function createGuard(config: {
  store: StoreAdapter;
  policy?: PolicyConfig;
  judge?: Judge;
  breakers?: { maxCallsPerMinute?: number; maxWritesPerRun?: number };
  scanners?: Scanner[];
}): VendoGuard {
  return new GuardImplementation(config);
}
