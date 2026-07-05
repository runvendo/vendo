/**
 * InProcessScheduler tests against the FROZEN core Scheduler seam: explicit
 * schedule() registration with a Principal that is replayed on every firing,
 * onFire handler wiring, cron/one-shot due-time computation with a fake clock.
 * Host-event ingest (a non-Scheduler path per the freeze) is tested via
 * host-events.ts.
 */
import { describe, expect, it } from "vitest";
import type { AutomationFiring, Principal } from "@vendoai/core";
import { InProcessScheduler } from "./in-process-scheduler";
import { createHostEventIngest, createSchedulerFiringHandler } from "./host-events";
import { AutomationRunner } from "./runner";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import type { RegisteredTool } from "./interpreter";
import { InMemoryAutomationStore } from "./store";

const alice: Principal = { tenantId: "t1", subject: "alice" };
const bob: Principal = { tenantId: "t1", subject: "bob" };

function makeTool(name: string) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    execute: async (input) => {
      calls.push(input);
      return { ok: true, result: { done: true } };
    },
  };
  return tool;
}

function eventSpec(): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "On transaction",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [{ id: "send", type: "tool", tool: "send_msg", input: { m: "{{ trigger.merchant }}" } }],
    },
  });
}

function scheduleSpec(trigger: Record<string, unknown>): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Scheduled",
    description: "test",
    prompt: "test",
    trigger,
    execution: {
      mode: "steps",
      steps: [{ id: "send", type: "tool", tool: "send_msg", input: { text: "tick" } }],
    },
  });
}

function setup(clockStart: string) {
  let nowIso = clockStart;
  const clock = {
    set: (iso: string) => (nowIso = iso),
    now: () => nowIso,
    nowMs: () => Date.parse(nowIso),
  };
  const store = new InMemoryAutomationStore({ now: clock.now });
  const send = makeTool("send_msg");
  const runner = new AutomationRunner({
    store,
    tools: async () => ({ send_msg: send }),
    policy: { evaluate: () => "allow" },
    now: clock.now,
    nowMs: clock.nowMs,
  });
  const scheduler = new InProcessScheduler({ nowMs: clock.nowMs });
  scheduler.onFire(createSchedulerFiringHandler(runner));
  return { store, send, runner, scheduler, clock };
}

describe("frozen Scheduler surface", () => {
  it("replays the scheduling Principal on every firing", async () => {
    const { scheduler, clock } = setup("2026-07-15T15:59:00.000Z");
    const firings: AutomationFiring[] = [];
    scheduler.onFire(async (firing) => {
      firings.push(firing);
    });
    await scheduler.schedule(
      "auto-9",
      { kind: "at", at: "2026-07-15T16:00:00.000Z" },
      { ...alice, claims: { plan: "pro" } },
    );
    clock.set("2026-07-15T16:00:30.000Z");
    await scheduler.tick();
    expect(firings).toHaveLength(1);
    expect(firings[0]!.principal).toEqual({ ...alice, claims: { plan: "pro" } });
    expect(firings[0]!.firedAt).toBe("2026-07-15T16:00:00.000Z");
  });

  it("cancel() stops future firings", async () => {
    const { scheduler, clock } = setup("2026-07-15T15:59:00.000Z");
    let fired = 0;
    scheduler.onFire(async () => {
      fired += 1;
    });
    await scheduler.schedule("auto-9", { kind: "at", at: "2026-07-15T16:00:00.000Z" }, alice);
    await scheduler.cancel("auto-9");
    clock.set("2026-07-15T16:00:30.000Z");
    await scheduler.tick();
    expect(fired).toBe(0);
  });
});

describe("cron schedules end-to-end", () => {
  it("fires when the cron occurrence passes in its timezone, exactly once", async () => {
    // 2026-07-05 is a Sunday. 17:00 America/Los_Angeles (PDT) = 2026-07-06T00:00Z.
    const { store, send, scheduler, clock } = setup("2026-07-05T23:58:00.000Z");
    const { automation } = await store.create(alice, {
      spec: scheduleSpec({ type: "schedule", cron: "0 17 * * 0", timezone: "America/Los_Angeles" }),
      grants: [],
    });
    await scheduler.schedule(
      automation.id,
      { kind: "cron", expression: "0 17 * * 0", timezone: "America/Los_Angeles" },
      alice,
    );

    clock.set("2026-07-05T23:59:00.000Z");
    await scheduler.tick();
    expect(send.calls).toHaveLength(0);

    clock.set("2026-07-06T00:01:00.000Z");
    await scheduler.tick();
    expect(send.calls).toHaveLength(1);

    clock.set("2026-07-06T00:02:00.000Z");
    await scheduler.tick();
    expect(send.calls).toHaveLength(1); // no re-fire until next Sunday
  });

  it("fires a one-shot `at` schedule once and never again", async () => {
    const { store, send, scheduler, clock } = setup("2026-07-15T15:58:00.000Z");
    const { automation } = await store.create(alice, {
      spec: scheduleSpec({ type: "schedule", at: "2026-07-15T16:00:00.000Z" }),
      grants: [],
    });
    await scheduler.schedule(
      automation.id,
      { kind: "at", at: "2026-07-15T16:00:00.000Z" },
      alice,
    );

    await scheduler.tick();
    expect(send.calls).toHaveLength(0);

    clock.set("2026-07-15T16:00:30.000Z");
    await scheduler.tick();
    expect(send.calls).toHaveLength(1);

    clock.set("2026-07-15T16:05:00.000Z");
    await scheduler.tick();
    expect(send.calls).toHaveLength(1);
  });
});

describe("host-event ingest (non-Scheduler path)", () => {
  it("fans out to matching automations of the event's subject only", async () => {
    const { store, send, runner, clock } = setup("2026-07-01T08:00:00.000Z");
    const ingest = createHostEventIngest({ store, runner });
    const { automation: mine } = await store.create(alice, { spec: eventSpec(), grants: [] });
    await store.create(bob, { spec: eventSpec(), grants: [] });

    await ingest(alice, "transaction.created", {
      eventId: "txn-1",
      occurredAt: clock.now(),
      payload: { merchant: "DoorDash" },
    });

    expect(send.calls).toEqual([{ m: "DoorDash" }]);
    expect(await store.listRuns(alice, mine.id)).toHaveLength(1);
  });

  it("ignores duplicate event ids", async () => {
    const { store, send, runner, clock } = setup("2026-07-01T08:00:00.000Z");
    const ingest = createHostEventIngest({ store, runner });
    await store.create(alice, { spec: eventSpec(), grants: [] });
    const event = { eventId: "txn-1", occurredAt: clock.now(), payload: { merchant: "DoorDash" } };
    await ingest(alice, "transaction.created", event);
    await ingest(alice, "transaction.created", event);
    expect(send.calls).toHaveLength(1);
  });
});
