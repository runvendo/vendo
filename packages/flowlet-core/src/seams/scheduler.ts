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
import type { Principal } from "./principal";

export interface Scheduler {
  /** Register (or replace) the durable schedule for an automation. The scope
   *  is persisted with the schedule and replayed on every firing. */
  schedule(automationId: string, trigger: TimeTrigger, scope: Principal): Promise<void>;
  cancel(automationId: string): Promise<void>;
  /** The runtime registers exactly one firing handler at startup. */
  onFire(handler: (firing: AutomationFiring) => Promise<void>): void;
}

export type TimeTrigger =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "at"; at: string };

export interface AutomationFiring {
  automationId: string;
  /** The scope the automation was scheduled under — the handler needs it to
   *  load the record (Store is Principal-scoped) and to acquire the brokered
   *  grant for the run. */
  principal: Principal;
  firedAt: string;
}
