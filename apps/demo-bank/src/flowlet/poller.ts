/**
 * The drop-in detector, now a pure EVENT ADAPTER. It polls Maple's EXISTING
 * transactions API (never a backend hook — true to "we didn't touch the
 * bank"), diffs for genuinely new rows, and emits each one as a
 * `transaction.created` event into the automations world. What happens next
 * (guards, messages, Slack) is automation data, not code here.
 *
 * Baseline-on-first-poll: every transaction present at startup (including the
 * planted $87 charge) is marked seen, so only orders placed AFTER the poller
 * starts can fire an automation. Duplicate protection is layered: the poller
 * diffs by id, and the runner dedupes on the deterministic firing id anyway.
 *
 * The poll tick also drives due schedules (scheduler.tick), so time-triggered
 * automations work in the demo without any server timers.
 */
import { listTransactions } from "@/server/transactions";
import {
  automationsWorld,
  type AutomationFireEvent,
  type DemoAutomationsWorld,
} from "./automations";

let seen: Set<string> | null = null;

export async function runPoll(
  world: DemoAutomationsWorld = automationsWorld(),
): Promise<AutomationFireEvent[]> {
  const { data } = listTransactions({ limit: 50 });

  // First poll establishes the baseline; nothing fires retroactively.
  if (seen === null) {
    seen = new Set(data.map((t) => t.id));
    world.drainFireEvents();
    return [];
  }

  for (const t of data) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    await world.emitTransaction(t);
  }
  await world.tick();
  return world.drainFireEvents();
}

/** Reset the baseline (used by the demo reset). */
export function resetPoller(): void {
  seen = null;
}
