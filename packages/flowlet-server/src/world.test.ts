import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { createAutomationsWorld } from "./world";
import { defaultFlowletPolicy } from "./default-policy";

describe("createAutomationsWorld", () => {
  const world = createAutomationsWorld({
    policy: defaultFlowletPolicy,
    model: { modelId: "stub" } as unknown as LanguageModel,
    scope: { tenantId: "flowlet-embedded", subject: "u1" },
  });

  it("exposes the full authoring toolset", () => {
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
    await expect(world.tick()).resolves.toBeUndefined();
  });

  it("wires the runner to in-app channels so terminal runs surface as deliveries", async () => {
    const scope = { tenantId: "flowlet-embedded", subject: "u1" };
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
