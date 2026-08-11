/**
 * `toolBrief` — the brief's tool section, which is the loadout's COMPLEMENT: the
 * tools this loop may never CALL but a screen's `onClick` may name. Everything
 * equipped arrives with its own schema instead, so what this printer receives is
 * the WRITE side of the registry, which is why every fixture below is graded that
 * way (`screen-agent.ts`'s `wireable`).
 */
import { UNKNOWN_INPUT_SCHEMA_NOTE, UNKNOWN_OUTPUT_SHAPE_NOTE } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { toolBrief } from "../src/screen-agent.js";

describe("the screen agent's tool brief", () => {
  it("prints a declared empty input as the fact it is, and a blind one as unknown", () => {
    const brief = toolBrief([
      {
        name: "host_goal_create",
        title: "Create goal",
        description: "Goals",
        risk: "write",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { data: { type: "array" } } },
      },
      {
        name: "host_voice_create",
        title: "Voice",
        description: "Voice",
        risk: "destructive",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ]);

    expect(brief).toContain('input: {"type":"object","properties":{}}');
    expect(brief).toContain('returns: {"type":"object"');
    expect(brief).toContain(UNKNOWN_INPUT_SCHEMA_NOTE);
    expect(brief).toContain(UNKNOWN_OUTPUT_SHAPE_NOTE);
  });

  it("says a product with nothing to wire has nothing to wire, in the SCREEN's terms", () => {
    // The empty sentence is what the model reads when the whole registry is
    // callable, and it is about what a SCREEN can reach — not about what this loop
    // can read, which is the claim it used to make. Nothing else pins the string,
    // so a rewrite would otherwise be invisible.
    expect(toolBrief([])).toBe("This product has no tools your screen could call.");
  });
});
