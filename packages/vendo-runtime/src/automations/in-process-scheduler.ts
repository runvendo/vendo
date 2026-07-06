/**
 * InProcessScheduler — the embedded implementation of the FROZEN core
 * `Scheduler` seam (time-based triggers only). Schedules are registered
 * explicitly with the Principal scope, which is persisted with the schedule
 * and REPLAYED on every firing (contracts freeze); the runtime registers one
 * firing handler via onFire().
 *
 * Host webhooks and Composio triggers deliberately do NOT pass through here —
 * they are ingest paths that invoke the same firing pipeline directly (see
 * host-events.ts). Composio trigger delivery needs a reachable webhook URL —
 * see @vendoai/next webhooks.
 *
 * Missed fires are skipped (the next occurrence wins) and the occurrence
 * timestamp doubles as the dedup eventId downstream, so a double tick can
 * never double-fire.
 */
import { Cron } from "croner";
import type { AutomationFiring, Principal, Scheduler, TimeTrigger } from "@vendoai/core";

export interface InProcessSchedulerConfig {
  /** Tick interval for start(); tests call tick() directly. */
  tickMs?: number;
  nowMs?: () => number;
  /** Called when a firing handler rejects; defaults to console.error. */
  onFireError?: (automationId: string, error: unknown) => void;
}

interface RegisteredSchedule {
  trigger: TimeTrigger;
  scope: Principal;
}

export class InProcessScheduler implements Scheduler {
  private readonly config: InProcessSchedulerConfig;
  private schedules = new Map<string, RegisteredSchedule>();
  private handler: ((firing: AutomationFiring) => Promise<void>) | undefined;
  private lastTickMs: number;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(config: InProcessSchedulerConfig = {}) {
    this.config = config;
    this.lastTickMs = this.nowMs();
  }

  private nowMs(): number {
    return this.config.nowMs?.() ?? Date.now();
  }

  async schedule(automationId: string, trigger: TimeTrigger, scope: Principal): Promise<void> {
    this.schedules.set(automationId, { trigger, scope });
  }

  async cancel(automationId: string): Promise<void> {
    this.schedules.delete(automationId);
  }

  onFire(handler: (firing: AutomationFiring) => Promise<void>): void {
    this.handler = handler;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.config.tickMs ?? 60_000);
    // Never keep a host process alive just for the scheduler.
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  /** One scheduling pass: fire every schedule due since the last tick. */
  async tick(): Promise<void> {
    const tickMs = this.nowMs();
    const windowStart = this.lastTickMs;
    this.lastTickMs = tickMs;
    if (!this.handler) return;

    for (const [automationId, registered] of this.schedules) {
      const due = dueOccurrence(registered.trigger, windowStart, tickMs);
      if (due === undefined) continue;
      const firedAt = new Date(due).toISOString();
      // One-shot occurrences are consumed whether or not delivery succeeds,
      // same as the missed-fires rule: the occurrence, not the delivery, is
      // what happens exactly once.
      if (registered.trigger.kind === "at") this.schedules.delete(automationId);
      try {
        await this.handler({ automationId, principal: registered.scope, firedAt });
      } catch (error) {
        // A failing handler must not reject tick() (start()'s interval has no
        // catch — an escape here is an unhandled rejection) nor starve the
        // remaining due schedules in this window.
        (this.config.onFireError ?? ((id, err) => console.error(`[vendo] scheduled firing failed for automation ${id}`, err)))(
          automationId,
          error,
        );
      }
    }
  }
}

/** Latest occurrence in (windowStart, now], or undefined. */
function dueOccurrence(
  trigger: TimeTrigger,
  windowStartMs: number,
  nowMs: number,
): number | undefined {
  if (trigger.kind === "at") {
    const atMs = Date.parse(trigger.at);
    return atMs > windowStartMs && atMs <= nowMs ? atMs : undefined;
  }
  const cron = new Cron(trigger.expression, { timezone: trigger.timezone });
  const next = cron.nextRun(new Date(windowStartMs));
  if (next && next.getTime() <= nowMs) return next.getTime();
  return undefined;
}
