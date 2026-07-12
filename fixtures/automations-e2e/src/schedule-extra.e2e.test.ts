/** 07 §2 schedule semantics the wave-4 baseline left thin: the `at` one-shot,
 * cron missed-window collapse (host asleep across N>2 windows), and the
 * start() auto-timer actually driving a real run and its stopper halting it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, enableAndApprove } from "./support.js";

const listRun = { kind: "steps" as const, steps: [{ id: "list", tool: "host_invoices_list" }] };

async function runCount(stack: Awaited<ReturnType<typeof createStack>>, appId: string): Promise<number> {
  return Number((await stack.sql<{ count: unknown }>(
    "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
    [appId],
  ))[0]?.count);
}

describe("schedule trigger extras", () => {
  beforeEach(resetFixture);

  it("fires an `at` one-shot exactly once and never again, gated by enable/disable", async () => {
    let clock = new Date("2026-07-12T09:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const appId = "app_at_oneshot";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: { on: { kind: "schedule", at: "2026-07-12T08:30:00.000Z" }, run: listRun },
      }));

      // Disarmed: a due `at` on a disabled automation does not fire.
      expect(await stack.automations.tick(clock)).toEqual([]);

      await enableAndApprove(stack, appId, ctx);
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      // Same and later ticks never re-fire the one-shot.
      expect(await stack.automations.tick(clock)).toEqual([]);
      clock = new Date("2026-07-12T10:00:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);

      await stack.automations.disable(appId, ctx);
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, appId)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("collapses a cron backlog of many missed windows into a single run", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const appId = "app_cron_collapse";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: { on: { kind: "schedule", cron: "0 * * * *" }, run: listRun },
      }));
      await enableAndApprove(stack, appId, ctx); // cursor anchored at 00:00

      // Host asleep until 03:00 — the 01:00, 02:00 and 03:00 windows all missed.
      clock = new Date("2026-07-12T03:00:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1); // exactly one, no back-fill
      expect(await stack.automations.tick(clock)).toEqual([]);     // next window (04:00) not yet due
      expect(await runCount(stack, appId)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("start() drives a due schedule on its own timer and the stopper halts it", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const appId = "app_start_timer";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: { on: { kind: "schedule", every: "1s" }, run: listRun },
      }));
      await enableAndApprove(stack, appId, ctx); // cursor anchored at 00:00

      // Advance one window into the future, then let the auto-timer notice it.
      clock = new Date("2026-07-12T00:00:02.000Z");
      const stop = stack.automations.start(20);
      try {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && (await runCount(stack, appId)) < 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await runCount(stack, appId)).toBe(1);
      } finally {
        stop();
      }

      // Stopper halts the timer: advancing the clock past more windows yields no
      // further runs because tick() is never invoked again.
      const afterStop = await runCount(stack, appId);
      clock = new Date("2026-07-12T00:00:30.000Z");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await runCount(stack, appId)).toBe(afterStop);
    } finally {
      await stack.close();
    }
  });
});
