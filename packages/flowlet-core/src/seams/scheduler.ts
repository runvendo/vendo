/**
 * Scheduler seam — firing automations when the user is away (Decisions 1/5).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | none, or host cron invoking the handler |
 * | Cloud | pg-boss worker in apps/cloud |
 *
 * This seam owns TIME-based triggers only. The other two trigger sources
 * (signed host webhooks, Composio triggers) are ingest paths that invoke the
 * same firing handler directly — they don't pass through the Scheduler.
 */
export interface Scheduler {
  /** Register (or replace) the durable schedule for an automation. */
  schedule(automationId: string, trigger: TimeTrigger): Promise<void>;
  cancel(automationId: string): Promise<void>;
  /** The runtime registers exactly one firing handler at startup. */
  onFire(handler: (firing: AutomationFiring) => Promise<void>): void;
}

export type TimeTrigger =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "at"; at: string };

export interface AutomationFiring {
  automationId: string;
  firedAt: string;
}
