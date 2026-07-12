/**
 * Ingest paths (spec section c, contracts freeze): host events and, later,
 * Composio trigger webhooks do NOT pass through the Scheduler seam — they
 * invoke the firing pipeline directly through
 * `runner.fire(scope, id, envelope)`.
 */
import type { AutomationFiring, Principal } from "@vendoai/core";
import type { AutomationRunner } from "./runner.js";
import type { AutomationEngineStore, AutomationRun, TriggerEnvelope } from "./store.js";

export interface HostEventIngestResult {
  /** Enabled automations whose host_event trigger matched this event name. */
  matched: number;
  /** Runs actually created. Duplicate event ids produce fewer runs. */
  fired: number;
  /** The event id used in every trigger envelope for this ingest call. */
  eventId: string;
  runs: AutomationRun[];
}

let generatedHostEventCounter = 0;

function generatedEventId(eventType: string, occurredAt: string): string {
  generatedHostEventCounter += 1;
  return `generated:${eventType}:${occurredAt}:${generatedHostEventCounter}`;
}

/**
 * Fan out to the subject's enabled automations matching the event type
 * (never tenant-wide) and fire each one.
 */
export async function fireHostEventAutomations(
  deps: {
    store: AutomationEngineStore;
    runner: AutomationRunner;
  },
  scope: Principal,
  eventType: string,
  event: {
    /** Producer-supplied id (e.g. the transaction id) — the dedup key. */
    eventId?: string;
    occurredAt?: string;
    payload: unknown;
  },
): Promise<HostEventIngestResult> {
  const occurredAt = event.occurredAt ?? new Date().toISOString();
  const eventId =
    typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : generatedEventId(eventType, occurredAt);
  const envelope: TriggerEnvelope = {
    source: "host",
    eventId,
    subject: scope.subject,
    occurredAt,
    payload: event.payload,
  };
  const matches = await deps.store.findEnabledByTrigger(scope, {
    kind: "host_event",
    key: eventType,
  });
  const runs: AutomationRun[] = [];
  for (const automation of matches) {
    try {
      const run = await deps.runner.fire(scope, automation.id, envelope);
      if (run) runs.push(run);
    } catch (error) {
      // Same isolation rule as InProcessScheduler.tick(): one automation's
      // failure (e.g. a transient store error) must not starve the other
      // matches of this event.
      console.error(`[vendo] host-event firing failed for automation ${automation.id}`, error);
    }
  }
  return { matched: matches.length, fired: runs.length, eventId, runs };
}

/**
 * The one firing handler the runtime registers on the Scheduler seam: turns an
 * AutomationFiring (which replays the scheduling Principal) into an envelope.
 * The occurrence timestamp is the eventId, so re-delivered ticks dedupe.
 */
export function createSchedulerFiringHandler(
  runner: AutomationRunner,
): (firing: AutomationFiring) => Promise<void> {
  return async (firing) => {
    await runner.fire(firing.principal, firing.automationId, {
      source: "cron",
      eventId: firing.firedAt,
      subject: firing.principal.subject,
      occurredAt: firing.firedAt,
      payload: { firedAt: firing.firedAt },
    });
  };
}
