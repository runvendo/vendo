import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { VendoError } from "@vendoai/core";
import { resolveModels } from "./models-config.js";

/** Marker-object factory standing in for vendoModel: resolveModels only
 *  composes lazily-resolving models, so identity + captured (name, slot) is
 *  the whole observable contract. */
function scriptedMake() {
  const made: Array<{ name: string | undefined; slot: string | undefined }> = [];
  const make = (name?: string, options?: { slot?: string }): LanguageModel => {
    made.push({ name, slot: options?.slot });
    return { scripted: true, name, slot: options?.slot } as unknown as LanguageModel;
  };
  return { made, make };
}

const explicitModel = (id: string): LanguageModel => ({ explicit: id } as unknown as LanguageModel);

describe("resolveModels (models block + deprecated aliases)", () => {
  it("zero config rides the ladder on both slots — agent default + invisible family paint", () => {
    const { made, make } = scriptedMake();
    const resolved = resolveModels({}, make);
    expect(resolved.agent.venue).toBe("ladder");
    expect(resolved.paint).toEqual({ model: expect.objectContaining({ slot: "paint" }) });
    expect(made).toEqual([
      { name: undefined, slot: "agent" },
      { name: undefined, slot: "paint" },
    ]);
  });

  it("models.agent as a string resolves through the ladder; as an object it wins as-is", () => {
    const { made, make } = scriptedMake();
    const viaString = resolveModels({ models: { agent: "claude-opus-4-8" } }, make);
    expect(viaString.agent.venue).toBe("ladder");
    expect(made[0]).toEqual({ name: "claude-opus-4-8", slot: "agent" });
    // A string-configured agent still rides the ladder, so paint stays the family fast pick.
    expect(viaString.paint).toEqual({ model: expect.objectContaining({ slot: "paint" }) });

    const object = explicitModel("byo");
    const viaObject = resolveModels({ models: { agent: object } }, scriptedMake().make);
    expect(viaObject.agent).toEqual({ model: object, venue: "custom" });
    // Explicit model object → paint falls back to that model as today (engine
    // fallback), so NO ladder paint model is composed.
    expect(viaObject.paint).toBeUndefined();
  });

  it("models.agent supersedes the deprecated top-level model, which stays functional", () => {
    const { make } = scriptedMake();
    const legacy = explicitModel("legacy");
    const preferred = explicitModel("preferred");
    expect(resolveModels({ model: legacy }, make).agent).toEqual({ model: legacy, venue: "custom" });
    expect(resolveModels({ model: legacy, models: { agent: preferred } }, make).agent)
      .toEqual({ model: preferred, venue: "custom" });
  });

  it("models.paint supersedes the deprecated paint.model; both forms still compose", () => {
    const { made, make } = scriptedMake();
    const legacyPaint = explicitModel("legacy-paint");
    const agent = explicitModel("agent");

    // Deprecated knob alone keeps working.
    expect(resolveModels({ model: agent, paint: { model: legacyPaint } }, make).paint)
      .toEqual({ model: legacyPaint });

    // models.paint string resolves through the ladder with the paint slot.
    const viaString = resolveModels({ model: agent, models: { paint: "claude-haiku-4-5" } }, make);
    expect(viaString.paint).toEqual({ model: expect.objectContaining({ name: "claude-haiku-4-5", slot: "paint" }) });
    expect(made).toContainEqual({ name: "claude-haiku-4-5", slot: "paint" });

    // models.paint object wins over the deprecated knob.
    const preferred = explicitModel("preferred-paint");
    expect(resolveModels({ model: agent, paint: { model: legacyPaint }, models: { paint: preferred } }, make).paint)
      .toEqual({ model: preferred });
  });

  it("paint.disabled stays the single-lane switch and suppresses the ladder paint model", () => {
    const { made, make } = scriptedMake();
    const resolved = resolveModels({ paint: { disabled: true } }, make);
    expect(resolved.paint).toEqual({ disabled: true });
    // Only the agent slot composed — no paint model behind a disabled lane.
    expect(made).toEqual([{ name: undefined, slot: "agent" }]);
  });

  it("rejects non-string non-object slot values and blank strings with a validation error", () => {
    const { make } = scriptedMake();
    expect(() => resolveModels({ models: { agent: 5 as unknown as string } }, make)).toThrow(VendoError);
    expect(() => resolveModels({ models: { paint: "   " } }, make)).toThrow(VendoError);
    expect(() => resolveModels({ models: { judge: null as unknown as string } }, make)).toThrow(VendoError);
  });
});
