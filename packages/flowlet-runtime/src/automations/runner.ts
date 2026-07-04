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
import type { AutomationDelivery, Channels, Principal } from "@flowlet/core";
import type { ApprovalPolicy } from "../policy";
import { evaluateGuard } from "./expressions";
import {
  interpret,
  type AgentStepRunner,
  type RegisteredTool,
} from "./interpreter";
import type { AutomationSpec } from "./schema";
import {
  DuplicateRunError,
  type AutomationEngineStore,
  type AutomationGrant,
  type AutomationRecord,
  type AutomationRun,
  type StepRecord,
  type TriggerEnvelope,
} from "./store";

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
  /** Off-thread delivery (FlowletToasts, 2026-07-04 spec): terminal runs and
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
      console.warn("flowlet: in-app delivery failed", err);
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

    if (outcome.status === "waiting_approval") {
      const waiting = await this.config.store.updateRun(scope, run.id, {
        outcome: "waiting_approval",
        steps: outcome.steps,
        pendingApproval: outcome.pendingApproval,
      });
      await this.notifyApproval(scope, waiting, automation, outcome.pendingApproval);
      return waiting;
    }
    return this.finalize(scope, run.id, automation, {
      status: outcome.status,
      steps: outcome.steps,
      error: outcome.status === "failed" ? outcome.error : undefined,
    });
  }

  private async finalize(
    scope: Principal,
    runId: string,
    automation: AutomationRecord,
    input: { status: "succeeded" | "failed"; steps?: StepRecord[]; error?: string },
  ): Promise<AutomationRun> {
    const { store } = this.config;
    const finalized = await store.finalizeRun(scope, runId, input);

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
    this.config.onRunFinished?.(finalized, automation);
    await this.notifyFinished(scope, finalized, automation);
    return finalized;
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
        if (!run || run.outcome !== "waiting_approval" || !run.pendingApproval) {
          return undefined; // already resumed, cancelled, or finished
        }
        const pending = run.pendingApproval;
        if (expectedStepId !== undefined && pending.stepId !== expectedStepId) {
          return undefined; // stale: the run moved on to a different pause
        }
        const automation = await this.config.store.get(scope, run.automationId);
        const version = automation
          ? await this.config.store.getVersion(scope, run.automationId, run.version)
          : undefined;
        if (!automation || !version) return undefined;

        // Expired approvals cancel instead of executing stale intent.
        if (Date.parse(pending.expiresAt) < this.nowMs()) {
          const expired = await this.config.store.finalizeRun(scope, run.id, {
            outcome: "cancelled",
            error: "pending approval expired",
          });
          await this.notifyFinished(scope, expired, automation);
          return expired;
        }
        // Claim the run before executing so nothing else sees it as pending.
        await this.config.store.updateRun(scope, run.id, { pendingApproval: undefined });
        const user = await this.claims(scope);
        return this.execute(scope, run, automation, version.spec, version.grants, user, {}, {
          checkpoint: pending.checkpoint,
          approved,
        });
      });
    })();
  }
}
