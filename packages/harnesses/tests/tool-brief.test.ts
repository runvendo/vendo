import { UNKNOWN_INPUT_SCHEMA_NOTE, UNKNOWN_OUTPUT_SHAPE_NOTE } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { toolBrief } from "../src/screen-agent.js";

describe("the screen agent's tool brief", () => {
  it("prints a declared empty input as the fact it is, and a blind one as unknown", () => {
    const brief = toolBrief([
      {
        name: "host_listGoals",
        title: "List goals",
        description: "Goals",
        risk: "read",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { data: { type: "array" } } },
      },
      {
        name: "host_voice_create",
        title: "Voice",
        description: "Voice",
        risk: "write",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ]);

    expect(brief).toContain('input: {"type":"object","properties":{}}');
    expect(brief).toContain('returns: {"type":"object"');
    expect(brief).toContain(UNKNOWN_INPUT_SCHEMA_NOTE);
    expect(brief).toContain(UNKNOWN_OUTPUT_SHAPE_NOTE);
  });
});
