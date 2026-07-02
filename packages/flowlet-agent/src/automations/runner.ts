/**
 * AutomationRunner — everything from "a firing exists" onward, identical in
 * every deployment (spec section c). Producers (in-process scheduler, demo
 * poller adapter, later pg-boss cron / webhook ingest) construct a trigger
 * envelope and call `fire`; nothing deployment-specific lives below that line.
 *
 * fire(): load -> dedup (deterministic run id) -> firing cap -> guard (false =>
 * compact skipped run) -> interpret -> finalize + counters -> disabled_error
 * after N consecutive failures. Firings are serialized per automation.
 */
import type { ApprovalPolicy } from "../policy";
import type { FlowletPrincipal } from "../principal";
import { evaluateGuard } from "./expressions";
import {
  interpret,
  type AgentStepRunner,
  type RegisteredTool,
} from "./interpreter";
import type { AutomationSpec } from "./schema";
import {
  DuplicateRunError,
  type AutomationGrant,
  type AutomationRecord,
  type AutomationRun,
  type AutomationStore,
  type StepRecord,
  type TriggerEnvelope,
} from "./store";

/** Consecutive failures before an automation is parked as disabled_error. */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

export interface AutomationRunnerConfig {
  store: AutomationStore;
  /** Build the registered toolset for a firing (host tools + integrations). */
  tools: (automation: AutomationRecord) => Promise<Record<string, RegisteredTool>>;
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
  /** Vouched claims exposed to expressions as `user`. */
  userClaims?: (automation: AutomationRecord) => Promise<Record<string, unknown>>;
  agentRunner?: AgentStepRunner;
  consecutiveFailureLimit?: number;
  now?: () => string;
  nowMs?: () => number;
  /** Observer hook (demo toast, logging). Called after each finalized run. */
  onRunFinished?: (run: AutomationRun, automation: AutomationRecord) => void;
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

  /** Serialize work per automation id; different automations run independently. */
  private enqueue<T>(automationId: string, work: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(automationId) ?? Promise.resolve();
    const next = tail.then(work, work);
    // Keep the chain alive regardless of individual outcomes.
    this.queues.set(
      automationId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Fire one envelope at one automation. Returns the finalized (or paused) run,
   * or undefined when nothing fired (unknown/disabled automation, duplicate).
   */
  fire(
    automationId: string,
    envelope: TriggerEnvelope,
    options: FireOptions = {},
  ): Promise<AutomationRun | undefined> {
    return this.enqueue(automationId, () => this.fireNow(automationId, envelope, options));
  }

  private async fireNow(
    automationId: string,
    envelope: TriggerEnvelope,
    options: FireOptions,
  ): Promise<AutomationRun | undefined> {
    const { store } = this.config;
    const automation = await store.getAutomation(automationId);
    if (!automation) return undefined;
    const statusOk =
      automation.status === "enabled" || (options.isTest === true && automation.status === "paused");
    if (!statusOk) return undefined;

    const version = await store.getVersion(automationId, automation.currentVersion);
    if (!version) return undefined;

    let run: AutomationRun;
    try {
      run = await store.createRun({
        automation,
        version: version.version,
        envelope,
        isTest: options.isTest ?? false,
        now: this.now(),
      });
    } catch (err) {
      if (err instanceof DuplicateRunError) return undefined; // redelivery no-op
      throw err;
    }

    // Firing cap — the run row IS the visible record of the drop.
    if (options.isTest !== true) {
      const cap = version.spec.limits.maxFiringsPerHour;
      const hourAgo = this.nowMs() - 60 * 60 * 1000;
      const recent = (await store.listRuns(automationId)).filter(
        (r) => r.id !== run.id && !r.isTest && Date.parse(r.startedAt) >= hourAgo,
      );
      if (recent.length >= cap) {
        const cancelled = await store.finalizeRun(run.id, {
          status: "cancelled",
          error: `dropped: exceeded maxFiringsPerHour (${cap})`,
          now: this.now(),
        });
        this.config.onRunFinished?.(cancelled, automation);
        return cancelled;
      }
    }

    const user = (await this.config.userClaims?.(automation)) ?? { id: automation.userId };

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
        return this.finalize(run.id, automation, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!pass) {
        const skipped = await store.finalizeRun(run.id, { status: "skipped", now: this.now() });
        this.config.onRunFinished?.(skipped, automation);
        return skipped;
      }
    }

    return this.execute(run, automation, version.spec, version.grants, user, options);
  }

  private async execute(
    run: AutomationRun,
    automation: AutomationRecord,
    spec: AutomationSpec,
    grants: AutomationGrant[],
    user: Record<string, unknown>,
    options: FireOptions,
    resume?: { checkpoint: unknown; approved: boolean },
  ): Promise<AutomationRun> {
    const tools = await this.config.tools(automation);
    const outcome = await interpret({
      spec,
      grants,
      runId: run.id,
      envelope: run.trigger,
      user,
      tools,
      policy: this.config.policy,
      principal: this.config.principal,
      agentRunner: this.config.agentRunner,
      dryRun: options.dryRun,
      now: this.config.now,
      nowMs: this.config.nowMs,
      resume,
    });

    if (outcome.status === "waiting_approval") {
      return this.config.store.updateRun(run.id, {
        status: "waiting_approval",
        steps: outcome.steps,
        pendingApproval: outcome.pendingApproval,
      });
    }
    return this.finalize(run.id, automation, {
      status: outcome.status,
      steps: outcome.steps,
      error: outcome.status === "failed" ? outcome.error : undefined,
    });
  }

  private async finalize(
    runId: string,
    automation: AutomationRecord,
    input: { status: "succeeded" | "failed" | "skipped"; steps?: StepRecord[]; error?: string },
  ): Promise<AutomationRun> {
    const { store } = this.config;
    const finalized = await store.finalizeRun(runId, { ...input, now: this.now() });

    if (input.status === "failed") {
      const limit = this.config.consecutiveFailureLimit ?? CONSECUTIVE_FAILURE_LIMIT;
      const fresh = await store.getAutomation(automation.id);
      if (fresh && fresh.counters.consecutiveFailures >= limit && fresh.status === "enabled") {
        await store.setStatus(automation.id, "disabled_error", this.now());
        await store.cancelPendingRuns(automation.id, this.now());
      }
    }
    this.config.onRunFinished?.(finalized, automation);
    return finalized;
  }

  /** Resume a waiting_approval run with the user's decision. */
  resume(runId: string, approved: boolean): Promise<AutomationRun | undefined> {
    return (async () => {
      const run = await this.config.store.getRun(runId);
      if (!run || run.status !== "waiting_approval" || !run.pendingApproval) return undefined;
      return this.enqueue(run.automationId, async () => {
        const automation = await this.config.store.getAutomation(run.automationId);
        const version = automation
          ? await this.config.store.getVersion(run.automationId, run.version)
          : undefined;
        if (!automation || !version) return undefined;

        // Expired approvals cancel instead of executing stale intent.
        if (Date.parse(run.pendingApproval!.expiresAt) < this.nowMs()) {
          return this.config.store.finalizeRun(run.id, {
            status: "cancelled",
            error: "pending approval expired",
            now: this.now(),
          });
        }
        const user = (await this.config.userClaims?.(automation)) ?? { id: automation.userId };
        return this.execute(run, automation, version.spec, version.grants, user, {}, {
          checkpoint: run.pendingApproval!.checkpoint,
          approved,
        });
      });
    })();
  }
}
