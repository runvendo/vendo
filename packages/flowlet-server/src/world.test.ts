import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { InProcessScheduler, type AutomationEngineStore } from "@flowlet/runtime";
import { createAutomationsWorld } from "./world";
import { defaultFlowletPolicy } from "./default-policy";

const STUB_MODEL = { modelId: "stub" } as unknown as LanguageModel;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAutomationsWorld", () => {
  it("exposes the full authoring toolset", async () => {
    const world = await createAutomationsWorld({
      policy: defaultFlowletPolicy,
      model: STUB_MODEL,
      scope: { tenantId: "flowlet-embedded", subject: "u1" },
    });
    const tools = world.authoringTools("thread-1");
    for (const name of [
      "create_automation",
      "update_automation",
      "delete_automation",
      "list_automations",
      "get_automation_runs",
      "pause_automation",
      "resume_automation",
      "run_automation_now",
    ]) {
      expect(tools[name], name).toBeDefined();
    }
  });

  it("ticks without registered tools or schedules", async () => {
    const world = await createAutomationsWorld({
      policy: defaultFlowletPolicy,
      model: STUB_MODEL,
      scope: { tenantId: "flowlet-embedded", subject: "u1" },
    });
    await expect(world.tick()).resolves.toBeUndefined();
  });

  it("wires the runner to in-app channels so terminal runs surface as deliveries", async () => {
    const scope = { tenantId: "flowlet-embedded", subject: "u1" };
    const world = await createAutomationsWorld({
      policy: defaultFlowletPolicy,
      model: STUB_MODEL,
      scope,
    });
    const { automation } = await world.store.create(scope, {
      spec: {
        dslVersion: 1,
        name: "Chase",
        description: "d",
        prompt: "p",
        trigger: { type: "host_event", event: "invoice.overdue" },
        execution: {
          mode: "steps",
          steps: [{ id: "noop", type: "tool", tool: "missing_tool", input: {} }],
        },
        limits: { maxFiringsPerHour: 10 },
      } as never,
      grants: [],
    });
    await world.runner.fire(scope, automation.id, {
      source: "host",
      eventId: "e1",
      subject: "u1",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    const deliveries = world.channels.listSince(scope, 0);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[0]!.message.automation?.kind).toBe("completed");
  });
});

describe("createAutomationsWorld — injected store", () => {
  it("wires an injected store into the runner/tools instead of the in-memory default", async () => {
    const list = vi.fn(async () => []);
    const store: AutomationEngineStore = {
      list,
      listEnabledSchedules: async () => [],
    } as unknown as AutomationEngineStore;
    const world = await createAutomationsWorld({
      policy: defaultFlowletPolicy,
      model: { modelId: "stub" } as unknown as LanguageModel,
      scope: { tenantId: "flowlet-embedded", subject: "u1" },
      store,
    });

    expect(world.store).toBe(store);

    const tools = world.authoringTools("thread-1");
    const result = await tools["list_automations"]!.execute!({}, { toolCallId: "t1", messages: [] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, automations: [] });
  });
});

describe("createAutomationsWorld — schedule rehydration", () => {
  it("re-registers every enabled durable schedule on the scheduler at assembly", async () => {
    const principal = { tenantId: "flowlet-embedded", subject: "u1" };
    const store = {
      listEnabledSchedules: async () => [
        {
          automationId: "auto-cron",
          trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
          principal,
        },
        {
          automationId: "auto-at",
          trigger: { type: "schedule", at: "2027-01-01T00:00:00.000Z" },
          principal,
        },
      ],
    } as unknown as AutomationEngineStore;
    const schedule = vi.spyOn(InProcessScheduler.prototype, "schedule");

    await createAutomationsWorld({
      policy: defaultFlowletPolicy,
      model: STUB_MODEL,
      scope: principal,
      store,
    });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledWith(
      "auto-cron",
      { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      principal,
    );
    expect(schedule).toHaveBeenCalledWith(
      "auto-at",
      { kind: "at", at: "2027-01-01T00:00:00.000Z" },
      principal,
    );
  });
});
