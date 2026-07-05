/**
 * Ingest paths (spec section c, contracts freeze): host events and, later,
 * Composio trigger webhooks do NOT pass through the Scheduler seam — they
 * invoke the firing pipeline directly. Both wiring helpers reduce a producer
 * to `runner.fire(scope, id, envelope)`.
 */
import type { AutomationFiring, Principal } from "@vendoai/core";
import type { AutomationRunner } from "./runner.js";
import type { AutomationEngineStore, TriggerEnvelope } from "./store.js";

export interface HostEventInput {
  /** Producer-supplied id (e.g. the transaction id) — the dedup key. */
  eventId: string;
  occurredAt: string;
  payload: unknown;
}

export type HostEventIngest = (
  scope: Principal,
  eventType: string,
  event: HostEventInput,
) => Promise<void>;

/**
 * Build the host-event ingest: fan out to the subject's enabled automations
 * matching the event type (never tenant-wide) and fire each one.
 */
export function createHostEventIngest(deps: {
  store: AutomationEngineStore;
  runner: AutomationRunner;
}): HostEventIngest {
  return async (scope, eventType, event) => {
    const envelope: TriggerEnvelope = {
      source: "host",
      eventId: event.eventId,
      subject: scope.subject,
      occurredAt: event.occurredAt,
      payload: event.payload,
    };
    const matches = await deps.store.findEnabledByTrigger(scope, {
      kind: "host_event",
      key: eventType,
    });
    for (const automation of matches) {
      try {
        await deps.runner.fire(scope, automation.id, envelope);
      } catch (error) {
        // Same isolation rule as InProcessScheduler.tick(): one automation's
        // failure (e.g. a transient store error) must not starve the other
        // matches of this event.
        console.error(`[vendo] host-event firing failed for automation ${automation.id}`, error);
      }
    }
  };
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
