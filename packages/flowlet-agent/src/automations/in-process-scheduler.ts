/**
 * InProcessScheduler — the embedded Scheduler-seam implementation (spec
 * section c). Two producers, both reduced to runner.fire() envelopes:
 *
 *  - a clock tick (start() interval or an external caller invoking tick())
 *    that computes due cron / one-shot schedules with croner, per-automation
 *    IANA timezone. Missed fires are skipped: the next occurrence wins, and
 *    the occurrence timestamp doubles as the dedup eventId.
 *  - emitHostEvent(): the host's own code path hands us a domain event; fan-out
 *    is per subject, never tenant-wide.
 *
 * Composio triggers need a reachable webhook endpoint and are cloud-only;
 * they never register here.
 */
import { Cron } from "croner";
import type { AutomationRunner } from "./runner";
import type { AutomationRecord, AutomationStore, TriggerEnvelope } from "./store";

export interface InProcessSchedulerConfig {
  store: AutomationStore;
  runner: AutomationRunner;
  /** Tick interval for start(); tests call tick() directly. */
  tickMs?: number;
  now?: () => string;
  nowMs?: () => number;
}

export interface HostEvent {
  tenantId: string;
  eventId: string;
  subject: string;
  occurredAt: string;
  payload: unknown;
}

export class InProcessScheduler {
  private readonly config: InProcessSchedulerConfig;
  private lastTickMs: number;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(config: InProcessSchedulerConfig) {
    this.config = config;
    this.lastTickMs = this.nowMs();
  }

  private now(): string {
    return this.config.now?.() ?? new Date().toISOString();
  }

  private nowMs(): number {
    return this.config.nowMs?.() ?? Date.now();
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

    const automations = await this.config.store.listAutomations();
    for (const automation of automations) {
      if (automation.status !== "enabled" || automation.triggerKind !== "schedule") continue;
      const due = await this.dueOccurrence(automation, windowStart, tickMs);
      if (due === undefined) continue;
      const occurredAt = new Date(due).toISOString();
      await this.config.runner.fire(automation.id, {
        source: "cron",
        eventId: occurredAt, // occurrence timestamp = idempotent dedup key
        subject: automation.userId,
        occurredAt,
        payload: { firedAt: occurredAt },
      });
    }
  }

  /** Latest occurrence in (windowStart, now], or undefined. */
  private async dueOccurrence(
    automation: AutomationRecord,
    windowStartMs: number,
    nowMs: number,
  ): Promise<number | undefined> {
    const version = await this.config.store.getVersion(
      automation.id,
      automation.currentVersion,
    );
    const trigger = version?.spec.trigger;
    if (!trigger || trigger.type !== "schedule") return undefined;

    if (trigger.at !== undefined) {
      const atMs = Date.parse(trigger.at);
      return atMs > windowStartMs && atMs <= nowMs ? atMs : undefined;
    }
    if (trigger.cron !== undefined) {
      const cron = new Cron(trigger.cron, { timezone: trigger.timezone });
      const next = cron.nextRun(new Date(windowStartMs));
      if (next && next.getTime() <= nowMs) return next.getTime();
    }
    return undefined;
  }

  /** Host-event producer: fan out to the subject's matching automations. */
  async emitHostEvent(eventType: string, event: HostEvent): Promise<void> {
    const envelope: TriggerEnvelope = {
      source: "host",
      eventId: event.eventId,
      subject: event.subject,
      occurredAt: event.occurredAt,
      payload: event.payload,
    };
    const matches = await this.config.store.findEnabledByTrigger({
      tenantId: event.tenantId,
      userId: event.subject,
      kind: "host_event",
      key: eventType,
    });
    for (const automation of matches) {
      await this.config.runner.fire(automation.id, envelope);
    }
  }
}
