/**
 * InProcessScheduler tests: cron/one-shot due-time computation with a fake
 * clock, and subject-scoped host-event fan-out. The runner + store are real
 * (in-memory); tools are stubs.
 */
import { describe, expect, it } from "vitest";
import { InProcessScheduler } from "./in-process-scheduler";
import { AutomationRunner } from "./runner";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import type { RegisteredTool } from "./interpreter";
import { InMemoryAutomationStore } from "./store";

function makeTool(name: string) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    execute: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };
  return tool;
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

async function setup(clockStart: string) {
  let nowIso = clockStart;
  const clock = {
    set: (iso: string) => (nowIso = iso),
    now: () => nowIso,
    nowMs: () => Date.parse(nowIso),
  };
  const store = new InMemoryAutomationStore();
  const send = makeTool("send_msg");
  const runner = new AutomationRunner({
    store,
    tools: async () => ({ send_msg: send }),
    policy: { evaluate: () => "allow" },
    principal: { userId: "user-1" },
    userClaims: async () => ({ id: "user-1" }),
    now: clock.now,
    nowMs: clock.nowMs,
  });
  const scheduler = new InProcessScheduler({
    store,
    runner,
    now: clock.now,
    nowMs: clock.nowMs,
  });
  return { store, send, runner, scheduler, clock };
}

describe("cron schedules", () => {
  it("fires when the cron occurrence passes in its timezone, exactly once", async () => {
    // 2026-07-05 is a Sunday. 17:00 America/Los_Angeles (PDT) = 2026-07-06T00:00Z.
    const { store, send, scheduler, clock } = await setup("2026-07-05T23:58:00.000Z");
    await store.createAutomation({
      tenantId: "t1",
      userId: "user-1",
      spec: scheduleSpec({ type: "schedule", cron: "0 17 * * 0", timezone: "America/Los_Angeles" }),
      grants: [],
      now: clock.now(),
    });

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
    const { send, store, scheduler, clock } = await setup("2026-07-15T15:58:00.000Z");
    await store.createAutomation({
      tenantId: "t1",
      userId: "user-1",
      spec: scheduleSpec({ type: "schedule", at: "2026-07-15T16:00:00.000Z" }),
      grants: [],
      now: clock.now(),
    });

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

describe("host events", () => {
  it("fans out to matching automations of the event's subject only", async () => {
    const { store, send, scheduler, clock } = await setup("2026-07-01T08:00:00.000Z");
    const { automation: alice } = await store.createAutomation({
      tenantId: "t1",
      userId: "alice",
      spec: eventSpec(),
      grants: [],
      now: clock.now(),
    });
    await store.createAutomation({
      tenantId: "t1",
      userId: "bob",
      spec: eventSpec(),
      grants: [],
      now: clock.now(),
    });

    await scheduler.emitHostEvent("transaction.created", {
      tenantId: "t1",
      eventId: "txn-1",
      subject: "alice",
      occurredAt: clock.now(),
      payload: { merchant: "DoorDash" },
    });

    expect(send.calls).toEqual([{ m: "DoorDash" }]);
    expect(await store.listRuns(alice.id)).toHaveLength(1);
  });

  it("ignores duplicate event ids", async () => {
    const { store, send, scheduler, clock } = await setup("2026-07-01T08:00:00.000Z");
    await store.createAutomation({
      tenantId: "t1",
      userId: "alice",
      spec: eventSpec(),
      grants: [],
      now: clock.now(),
    });
    const event = {
      tenantId: "t1",
      eventId: "txn-1",
      subject: "alice",
      occurredAt: clock.now(),
      payload: { merchant: "DoorDash" },
    };
    await scheduler.emitHostEvent("transaction.created", event);
    await scheduler.emitHostEvent("transaction.created", event);
    expect(send.calls).toHaveLength(1);
  });
});
