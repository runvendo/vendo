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
});
