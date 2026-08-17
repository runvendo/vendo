/** 07 §2 schedule semantics the wave-4 baseline left thin: the `at` one-shot,
 * cron missed-window collapse (host asleep across N>2 windows), and the
 * start() auto-timer actually driving a real run and its stopper halting it.
 * The unit is the RECORD now, so the kill switch takes the automation id alone
 * — there is no trigger to name.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, enableAndApprove, runCount } from "../src/support.js";

const listTask = { kind: "steps" as const, steps: [{ id: "list", tool: "host_invoices_list" }] };

describe("schedule trigger extras", () => {
  beforeEach(resetFixture);

  it("fires an `at` one-shot exactly once and never again, gated by enable/disable", async () => {
    let clock = new Date("2026-07-12T09:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const ctx = ownerCtx(ADA.subject);
      // Created DISARMED, and dated ahead of the create — a past `at` is a
      // validation error at the create door, so the window has to be reached by
      // moving the clock rather than by back-dating the record.
      const { id } = await stack.create({
        owner: ADA,
        when: { at: "2026-07-12T09:30:00.000Z" },
        task: listTask,
        authoredBy: "chat",
        armed: false,
      }, ctx);

      // Disarmed: a due `at` on a disarmed automation does not fire.
      clock = new Date("2026-07-12T09:31:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);

      await enableAndApprove(stack, id, ctx);
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      // Same and later ticks never re-fire the one-shot.
      expect(await stack.automations.tick(clock)).toEqual([]);
      clock = new Date("2026-07-12T10:00:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);

      await stack.automations.disable(id, ctx);
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, id)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("collapses a cron backlog of many missed windows into a single run", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: "0 * * * *",
        task: listTask,
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx); // cursor anchored at 00:00

      // Host asleep until 03:00 — the 01:00, 02:00 and 03:00 windows all missed.
      clock = new Date("2026-07-12T03:00:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1); // exactly one, no back-fill
      expect(await stack.automations.tick(clock)).toEqual([]);     // next window (04:00) not yet due
      expect(await runCount(stack, id)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("start() drives a due schedule on its own timer and the stopper halts it", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { every: "1s" },
        task: listTask,
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx); // cursor anchored at 00:00

      // Advance one window into the future, then let the auto-timer notice it.
      clock = new Date("2026-07-12T00:00:02.000Z");
      const stop = stack.automations.start(20);
      try {
        // A poll inside a test must never have a budget TIGHTER than the test's
        // own: this suite's testTimeout is 120s, and a 5s wall clock here was a
        // second, invisible speed limit that would report "expected 0 to be 1"
        // — a scheduler bug — for nothing worse than a busy machine. 60s keeps
        // vitest's timeout the single hang-detector and costs a green run
        // nothing (the timer fires in ~20ms when the box is idle).
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && (await runCount(stack, id)) < 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await runCount(stack, id)).toBe(1);
      } finally {
        stop();
      }

      // Stopper halts the timer: advancing the clock past more windows yields no
      // further runs because tick() is never invoked again.
      const afterStop = await runCount(stack, id);
      clock = new Date("2026-07-12T00:00:30.000Z");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await runCount(stack, id)).toBe(afterStop);
    } finally {
      await stack.close();
    }
  });
});
