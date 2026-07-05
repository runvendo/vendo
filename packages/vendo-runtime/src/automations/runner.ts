/**
 * AutomationRunner — everything from "a firing exists" onward, identical in
 * every deployment (spec section c). Producers construct a trigger envelope
 * and call `fire` with the Principal the automation was scheduled under (the
 * frozen Scheduler seam replays it on every AutomationFiring); host webhooks
 * and Composio triggers are ingest paths that reach the same method directly.
 *
 * fire(): load -> dedup (deterministic run id) -> firing cap -> guard (false =>
 * compact skipped run) -> interpret -> finalize + counters. After N
 * consecutive failures the automation is parked: frozen status "paused" plus
 * disabledReason (the frozen status union stays untouched).
 */
import type { AuditLog, AutomationDelivery, Channels, Principal } from "@vendoai/core";
import type { ApprovalPolicy } from "../policy/index.js";
import { evaluateGuard } from "./expressions.js";
import { hashDescriptor } from "./grants.js";
import {
  interpret,
  type AgentStepRunner,
  type RegisteredTool,
} from "./interpreter.js";
import type { AutomationSpec } from "./schema.js";
import {
  DuplicateRunError,
  PARKED_ACTION_TTL_MS,
  type AutomationEngineStore,
  type AutomationGrant,
  type AutomationRecord,
  type AutomationRun,
  type StepRecord,
  type TriggerEnvelope,
} from "./store.js";

/** Consecutive failures before an automation is parked (spec amendment). */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

export interface AutomationRunnerConfig {
  store: AutomationEngineStore;
  /** Build the registered toolset for a firing (host tools + integrations). */
  tools: (
    scope: Principal,
    automation: AutomationRecord,
  ) => Promise<Record<string, RegisteredTool>>;
  policy: ApprovalPolicy;
  /** Vouched claims exposed to expressions as `user`; defaults to the scope. */
  userClaims?: (scope: Principal) => Promise<Record<string, unknown>>;
  agentRunner?: AgentStepRunner;
  consecutiveFailureLimit?: number;
  now?: () => string;
  nowMs?: () => number;
  /** Observer hook (demo toast, logging). Called after each finalized run. */
  onRunFinished?: (run: AutomationRun, automation: AutomationRecord) => void;
  /** ENG-193 §6.2 — records parked-action resolutions on the SAME "consent"
   *  audit event kind chat approvals already use (Task 5). Optional: tests
   *  that don't care about the trail can omit it. */
  audit?: AuditLog;
  /** Maps the engine scope onto the core audit Principal shape — structurally
   *  identical today ({tenantId, subject}); defaults to the identity. */
  auditPrincipal?: (scope: Principal) => Principal;
  /** Off-thread delivery (VendoToasts, 2026-07-04 spec): terminal runs and
   *  approval pauses go out as in-app messages. Best-effort — a down surface
   *  must never fail the run. Guard-false skips and bulk park-cancellations
   *  are deliberately silent (routine, would spam). */
  channels?: Channels;
}

export interface FireOptions {
  /** run_automation_now: flagged in history; bypasses the paused status check. */
  isTest?: boolean;
  /** Dry-run: mutating steps simulated (the run_automation_now default). */
  dryRun?: boolean;
}

export class AutomationRunner {
  private readonly config: AutomationRunnerConfig;
  /** Per-automation promise chain — serialized firings (open question 13). */
  private queues = new Map<string, Promise<unknown>>();

  constructor(config: AutomationRunnerConfig) {
    this.config = config;
  }

  private now(): string {
    return this.config.now?.() ?? new Date().toISOString();
  }

  private nowMs(): number {
    return this.config.nowMs?.() ?? Date.now();
  }

  private async claims(scope: Principal): Promise<Record<string, unknown>> {
    if (this.config.userClaims) return this.config.userClaims(scope);
    return { id: scope.subject, ...scope.claims };
  }

  /** Deliver a terminal-run toast. Skipped runs never reach this. */
  private async notifyFinished(
    scope: Principal,
    run: AutomationRun,
    automation: AutomationRecord,
  ): Promise<void> {
    const outcome =
      run.outcome === "cancelled"
        ? (run.error ?? "cancelled")
        : run.status === "failed"
          ? `failed: ${run.error ?? "unknown error"}`
          : "finished";
    await this.notify(scope, {
      text: `Automation "${automation.name}" ${outcome}.`,
      automation: { kind: "completed", runId: run.id, summary: `${automation.name}: ${outcome}` },
    });
  }

  private async notifyApproval(
    scope: Principal,
    run: AutomationRun,
    automation: AutomationRecord,
    pending: { stepId: string; tool: string },
  ): Promise<void> {
    await this.notify(scope, {
      text: `Automation "${automation.name}" needs your approval to run ${pending.tool}.`,
      automation: {
        kind: "approval-required",
        runId: run.id,
        stepId: pending.stepId,
        summary: `${automation.name} wants to run ${pending.tool}`,
      },
    });
  }

  private async notify(
    scope: Principal,
    message: { text: string; automation: AutomationDelivery },
  ): Promise<void> {
    if (!this.config.channels) return;
    try {
      await this.config.channels.deliver({ channel: "in-app", principal: scope, ...message });
    } catch (err) {
      // Best-effort by design: the run already reached its true state; a dead
      // toast surface must not flip it. The event stays visible in run history.
      console.warn("vendo: in-app delivery failed", err);
    }
  }

  /** Serialize work per automation id; different automations run independently. */
  private enqueue<T>(automationId: string, work: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(automationId) ?? Promise.resolve();
    const next = tail.then(work, work);
    this.queues.set(
      automationId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Fire one envelope at one automation. Returns the finalized (or paused) run,
   * or undefined when nothing fired (unknown/paused automation, duplicate).
   */
  fire(
    scope: Principal,
    automationId: string,
    envelope: TriggerEnvelope,
    options: FireOptions = {},
  ): Promise<AutomationRun | undefined> {
    return this.enqueue(automationId, () => this.fireNow(scope, automationId, envelope, options));
  }

  private async fireNow(
    scope: Principal,
    automationId: string,
    envelope: TriggerEnvelope,
    options: FireOptions,
  ): Promise<AutomationRun | undefined> {
    const { store } = this.config;
    const automation = await store.get(scope, automationId);
    if (!automation) return undefined;
    if (automation.status !== "enabled" && options.isTest !== true) return undefined;

    const version = await store.getVersion(scope, automationId, automation.currentVersion);
    if (!version) return undefined;

    let run: AutomationRun;
    try {
      run = await store.createRun(scope, {
        automation,
        version: version.version,
        envelope,
        isTest: options.isTest ?? false,
      });
    } catch (err) {
      if (err instanceof DuplicateRunError) return undefined; // redelivery no-op
      throw err;
    }

    // Firing cap — the run row IS the visible record of the drop.
    if (options.isTest !== true) {
      const cap = version.spec.limits.maxFiringsPerHour;
      const hourAgo = this.nowMs() - 60 * 60 * 1000;
      const recent = (await store.listRuns(scope, automationId)).filter(
        (r) => r.id !== run.id && !r.isTest && Date.parse(r.startedAt) >= hourAgo,
      );
      if (recent.length >= cap) {
        const cancelled = await store.finalizeRun(scope, run.id, {
          outcome: "cancelled",
          error: `dropped: exceeded maxFiringsPerHour (${cap})`,
        });
        await this.parkIfSpentOneShot(scope, automationId);
        this.config.onRunFinished?.(cancelled, automation);
        await this.notifyFinished(scope, cancelled, automation);
        return cancelled;
      }
    }

    const user = await this.claims(scope);

    // Top-level guard: false is a compact skipped run, never a failure.
    if (version.spec.if !== undefined) {
      let pass: boolean;
      try {
        pass = await evaluateGuard(version.spec.if, {
          trigger: envelope.payload,
          steps: {},
          run: { id: run.id, automationId, firedAt: envelope.occurredAt },
          user,
        });
      } catch (err) {
        return this.finalize(scope, run.id, automation, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!pass) {
        const skipped = await store.finalizeRun(scope, run.id, { outcome: "skipped" });
        if (options.isTest !== true) await this.parkIfSpentOneShot(scope, automationId);
        this.config.onRunFinished?.(skipped, automation);
        return skipped;
      }
    }

    return this.execute(scope, run, automation, version.spec, version.grants, user, options);
  }

  private async execute(
    scope: Principal,
    run: AutomationRun,
    automation: AutomationRecord,
    spec: AutomationSpec,
    grants: AutomationGrant[],
    user: Record<string, unknown>,
    options: FireOptions,
    resume?: { checkpoint: unknown; approved: boolean },
  ): Promise<AutomationRun> {
    const tools = await this.config.tools(scope, automation);
    const outcome = await interpret({
      spec,
      grants,
      runId: run.id,
      automationId: automation.id,
      envelope: run.trigger,
      user,
      tools,
      policy: this.config.policy,
      principal: { userId: scope.subject },
      agentRunner: this.config.agentRunner,
      dryRun: options.dryRun,
      now: this.config.now,
      nowMs: this.config.nowMs,
      resume,
    });

    // ENG-193 §4.6: persist every parked draft this pass produced, regardless
    // of the run's outcome — a run can park several actions before ALSO
    // pausing at a later direct-step checkpoint (§4.6's own text: parking and
    // run-checkpoint pausing coexist).
    for (const draft of outcome.parkedActions) {
      await this.config.store.createParkedAction(scope, {
        automationId: automation.id,
        runId: run.id,
        stepId: draft.stepId,
        tool: draft.tool,
        input: draft.input,
        ...(draft.guardExpr !== undefined ? { guardExpr: draft.guardExpr } : {}),
        ...(draft.guardBindings !== undefined ? { guardBindings: draft.guardBindings } : {}),
        reason: draft.reason,
        tier: draft.tier,
        descriptorHash: draft.descriptorHash,
        requestedAt: draft.requestedAt,
      });
    }
    const parkedCount = run.parkedCount + outcome.parkedActions.length;

    if (outcome.status === "waiting_approval") {
      const waiting = await this.config.store.updateRun(scope, run.id, {
        outcome: "waiting_approval",
        steps: outcome.steps,
        pendingApproval: outcome.pendingApproval,
        parkedCount,
      });
      await this.notifyApproval(scope, waiting, automation, outcome.pendingApproval);
      return waiting;
    }
    return this.finalize(scope, run.id, automation, {
      status: outcome.status,
      steps: outcome.steps,
      error: outcome.status === "failed" ? outcome.error : undefined,
      parkedCount,
    });
  }

  private async finalize(
    scope: Principal,
    runId: string,
    automation: AutomationRecord,
    input: {
      status: "succeeded" | "failed";
      steps?: StepRecord[];
      error?: string;
      parkedCount?: number;
    },
  ): Promise<AutomationRun> {
    const { store } = this.config;
    const finalized = await store.finalizeRun(scope, runId, input);

    await this.config.audit?.append({
      at: this.now(),
      principal: (this.config.auditPrincipal ?? ((s) => s))(scope),
      kind: "automation_firing",
      automationId: automation.id,
      runId: finalized.id,
    });

    if (input.status === "failed") {
      const limit = this.config.consecutiveFailureLimit ?? CONSECUTIVE_FAILURE_LIMIT;
      const fresh = await store.get(scope, automation.id);
      if (fresh && fresh.counters.consecutiveFailures >= limit && fresh.status === "enabled") {
        await store.setStatus(scope, automation.id, "paused", {
          disabledReason: "consecutive_failures",
        });
        await store.cancelPendingRuns(scope, automation.id);
      }
    }

    if (!finalized.isTest) await this.parkIfSpentOneShot(scope, automation.id);
    this.config.onRunFinished?.(finalized, automation);
    await this.notifyFinished(scope, finalized, automation);
    return finalized;
  }

  /**
   * A one-shot schedule (`at`) is spent once its firing finalizes — however it
   * finalized (success, failure, guard-skip, cap-cancel, expired approval) —
   * so park it; otherwise durable stores would rehydrate it as "enabled"
   * forever. Callers gate on isTest: run_automation_now never spends it.
   */
  private async parkIfSpentOneShot(scope: Principal, automationId: string): Promise<void> {
    const fresh = await this.config.store.get(scope, automationId);
    const trigger = fresh?.spec.trigger;
    if (fresh?.status === "enabled" && trigger?.type === "schedule" && trigger.at !== undefined) {
      await this.config.store.setStatus(scope, automationId, "paused", {
        disabledReason: "completed_one_shot",
      });
    }
  }

  /** Resume a waiting_approval run with the user's decision. When
   *  `expectedStepId` is given (an approval surface acting on a specific
   *  pause), a run now paused on a DIFFERENT step answers undefined (stale)
   *  instead of approving something the user never saw. */
  resume(
    scope: Principal,
    runId: string,
    approved: boolean,
    expectedStepId?: string,
  ): Promise<AutomationRun | undefined> {
    return (async () => {
      // The outside read is ONLY for the queue key. The authoritative check
      // happens inside the per-automation queue: two rapid approvals would
      // otherwise both pass a pre-queue check and double-execute (review P1;
      // the concurrent-resume test settles it).
      const peek = await this.config.store.getRun(scope, runId);
      if (!peek) return undefined;
      return this.enqueue(peek.automationId, async () => {
        const run = await this.config.store.getRun(scope, runId);
        if (!run) return undefined;
        if (
          expectedStepId !== undefined &&
          run.pendingApproval?.stepId !== expectedStepId
        ) {
          return undefined; // stale: the run moved on to a different pause
        }
        const automation = await this.config.store.get(scope, run.automationId);
        const version = automation
          ? await this.config.store.getVersion(scope, run.automationId, run.version)
          : undefined;
        if (!automation || !version) return undefined;

        // Atomically claim the approval: exactly one resumer gets it, and the
        // run stops being pending in the same operation. A lost claim means
        // the run was already resumed, cancelled, or finished.
        const pending = await this.config.store.claimPendingApproval(scope, runId);
        if (!pending) return undefined;

        // Expired approvals cancel instead of executing stale intent.
        if (Date.parse(pending.expiresAt) < this.nowMs()) {
          const expired = await this.config.store.finalizeRun(scope, run.id, {
            outcome: "cancelled",
            error: "pending approval expired",
          });
          if (!run.isTest) await this.parkIfSpentOneShot(scope, run.automationId);
          await this.notifyFinished(scope, expired, automation);
          return expired;
        }
        const user = await this.claims(scope);
        return this.execute(scope, run, automation, version.spec, version.grants, user, {}, {
          checkpoint: pending.checkpoint,
          approved,
        });
      });
    })();
  }

  /**
   * Resolve a parked action (ENG-193 §4.6) — late, STANDALONE execution: no
   * interpreter re-run, no re-resolution of input (frozen at park time).
   * Reuses the SAME per-automation queue `resume()` relies on for its
   * "two rapid approvals must not double-execute" guarantee (spec §8's
   * parked-critical-executes-exactly-once invariant rides this, not a new
   * mechanism — plan deviation #3).
   */
  async resolveParkedAction(
    scope: Principal,
    actionId: string,
    decision: "approved" | "declined",
  ): Promise<
    | { ok: true; executed: boolean; skipped?: boolean; reason?: string; guardStale?: boolean }
    | { ok: false; error: string }
  > {
    const peek = await this.config.store.getParkedAction(scope, actionId);
    if (!peek) return { ok: false, error: `parked action "${actionId}" not found` };
    if (peek.resolution !== undefined) {
      return { ok: false, error: `parked action "${actionId}" is already resolved (${peek.resolution})` };
    }
    return this.enqueue(peek.automationId, async () => {
      // Re-peek inside the queue: a sibling concurrent call may have resolved
      // it while this one waited (the SAME race resume() guards against).
      const action = await this.config.store.getParkedAction(scope, actionId);
      if (!action || action.resolution !== undefined) {
        return { ok: false, error: `parked action "${actionId}" is already resolved` };
      }

      if (decision === "declined") {
        // A decline claims immediately — there is no execution whose outcome
        // the resolution could misrepresent.
        await this.config.store.resolveParkedAction(scope, actionId, "declined", this.now());
        await this.appendConsentAudit(scope, actionId, "no");
        return { ok: true, executed: false };
      }

      const automation = await this.config.store.get(scope, action.automationId);
      if (!automation) return { ok: false, error: `automation "${action.automationId}" not found` };
      const tools = await this.config.tools(scope, automation);
      const tool = tools[action.tool];
      if (!tool) return { ok: false, error: `tool "${action.tool}" is no longer registered` };

      // Descriptor drift (spec §8.8): a tool whose safety identity changed
      // since park time is never executed on the stale approval — the row
      // stays UNRESOLVED (re-askable), not silently declined.
      const liveHash = hashDescriptor(tool.descriptor);
      if (liveHash !== action.descriptorHash) {
        return {
          ok: false,
          error: `tool "${action.tool}" changed since this was parked — approval must be requested again`,
        };
      }

      // Frozen-input integrity (review follow-up): an input cut at the storage
      // cap can never be executed faithfully — executing the truncated remnant
      // would silently do something OTHER than what the card showed. Fail
      // closed like descriptor drift: refuse, leave the row unresolved.
      if (action.inputTruncated === true) {
        return {
          ok: false,
          error:
            `the parked input for "${action.tool}" was truncated at park time and cannot be ` +
            "executed safely — the action must be requested again",
        };
      }

      // TTL holds on the raw API path too, not just the list sweep: a stale
      // intent is never approvable by direct replay of a resolve request.
      if (Date.parse(action.requestedAt) + PARKED_ACTION_TTL_MS <= this.nowMs()) {
        await this.config.store.resolveParkedAction(scope, action.id, "expired", this.now());
        return {
          ok: false,
          error: `this request expired ${PARKED_ACTION_TTL_MS / 86_400_000} days after it was parked — ask again if it is still wanted`,
        };
      }

      // Policy is consulted at resolve time too (mirrors executeToolStep's
      // own "deny" branch): a tenant/role deny always wins over the human's
      // "approved" decision. Left UNRESOLVED like descriptor drift — a
      // policy verdict can change, unlike a declined human answer.
      const policyDecision = await this.config.policy.evaluate({
        toolName: action.tool,
        input: action.input,
        descriptor: tool.descriptor,
        principal: { userId: scope.subject },
      });
      if (policyDecision === "deny") {
        return { ok: false, error: `policy denied tool "${action.tool}"` };
      }

      // Guard re-check (deviation #2): only when it's provably self-contained
      // (no steps reference, dot OR bracket form) — otherwise flagged stale,
      // never re-evaluated.
      let guardStale = false;
      if (action.guardExpr !== undefined && !/\bsteps\s*[.[]/.test(action.guardExpr)) {
        const run = await this.config.store.getRun(scope, action.runId);
        const scopeForGuard = {
          trigger: run?.trigger.payload,
          steps: {},
          run: { id: action.runId, automationId: action.automationId, firedAt: run?.trigger.occurredAt ?? "" },
          user: await this.claims(scope),
          ...(action.guardBindings ?? {}),
        };
        const stillHolds = await evaluateGuard(action.guardExpr, scopeForGuard);
        if (!stillHolds) {
          // The human still said yes — the resolution is "approved"; only the
          // execution is skipped (the design's own worked example: "the
          // invoice may have been paid since").
          await this.config.store.resolveParkedAction(scope, actionId, "approved", this.now());
          await this.appendConsentAudit(scope, actionId, "yes");
          return { ok: true, executed: false, skipped: true, reason: "guard no longer holds" };
        }
      } else if (action.guardExpr !== undefined) {
        // References steps — never re-checked (deviation #2). Executes with
        // the frozen input; the WaitingList copy is responsible for saying
        // its conditions can't be re-verified.
        guardStale = true;
      }

      // Execute FIRST, claim AFTER (review follow-up): the per-automation
      // queue already serializes resolves, so nothing can double-execute
      // before the claim lands — and a FAILED execute must leave the row
      // UNRESOLVED (re-askable) with no consent event claiming success. A
      // retry reuses the SAME `parked-<id>` idempotency key, so an executor
      // that dedupes by key cannot double-fire across retries either.
      const idempotencyKey = `${action.runId}/${action.stepId}/parked-${action.id}`;
      const outcome = await tool.execute(action.input as Record<string, unknown>, { idempotencyKey });
      if (!outcome.ok) return { ok: false, error: outcome.error.message };

      await this.config.audit?.append({
        at: this.now(),
        principal: (this.config.auditPrincipal ?? ((s) => s))(scope),
        kind: "tool_execution",
        toolName: action.tool,
        toolCallId: `parked-${action.id}`,
        mutating: true, // every parked action is a gated, non-read tool by construction
        dangerous: action.tier === "critical",
        outcome: "ok",
      });

      await this.config.store.resolveParkedAction(scope, actionId, "approved", this.now());
      await this.appendConsentAudit(scope, actionId, "yes");
      return { ok: true, executed: true, ...(guardStale ? { guardStale: true } : {}) };
    });
  }

  /** One consent audit event per RESOLUTION (never before the outcome is
   *  known — the trail must not claim an execution that then failed). */
  private async appendConsentAudit(
    scope: Principal,
    actionId: string,
    decision: "yes" | "no",
  ): Promise<void> {
    await this.config.audit?.append({
      at: this.now(),
      principal: (this.config.auditPrincipal ?? ((s) => s))(scope),
      kind: "consent",
      consentId: actionId,
      decision,
    });
  }
}
