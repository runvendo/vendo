import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { VendoError } from "@vendoai/core";
import { resolveModels } from "../src/models-config.js";

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

  it("models.default as a string resolves through the ladder; as an object it wins as-is", () => {
    const { made, make } = scriptedMake();
    const viaString = resolveModels({ models: { default: "claude-opus-4-8" } }, make);
    expect(viaString.agent.venue).toBe("ladder");
    expect(made[0]).toEqual({ name: "claude-opus-4-8", slot: "agent" });
    // A string-configured agent still rides the ladder, so paint stays the family fast pick.
    expect(viaString.paint).toEqual({ model: expect.objectContaining({ slot: "paint" }) });

    const object = explicitModel("byo");
    const viaObject = resolveModels({ models: { default: object } }, scriptedMake().make);
    expect(viaObject.agent).toEqual({ model: object, venue: "custom" });
    // Explicit model object → paint falls back to that model as today (engine
    // fallback), so NO ladder paint model is composed.
    expect(viaObject.paint).toBeUndefined();
  });

  it("models.fill names the paint lane's model; the deprecated paint.model still composes", () => {
    const { made, make } = scriptedMake();
    const agent = explicitModel("agent");

    // Deprecated knob alone keeps working.
    expect(resolveModels({ model: agent, paint: { model: explicitModel("legacy-paint") } }, make).paint)
      .toEqual({ model: explicitModel("legacy-paint") });

    // models.fill as a string resolves through the ladder with the paint slot.
    const viaString = resolveModels({ model: agent, models: { fill: "claude-haiku-4-5" } }, make);
    expect(viaString.paint).toEqual({ model: expect.objectContaining({ name: "claude-haiku-4-5", slot: "paint" }) });
    expect(made).toContainEqual({ name: "claude-haiku-4-5", slot: "paint" });

    // models.fill as an object wins as-is.
    const preferred = explicitModel("preferred-paint");
    expect(resolveModels({ model: agent, models: { fill: preferred } }, make).paint)
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
    expect(() => resolveModels({ models: { default: 5 as unknown as string } }, make)).toThrow(VendoError);
    expect(() => resolveModels({ models: { fill: "   " } }, make)).toThrow(VendoError);
    expect(() => resolveModels({ models: { judge: null as unknown as string } }, make)).toThrow(VendoError);
  });

  it("refuses a models key that is not a seat instead of ignoring it", () => {
    const { make } = scriptedMake();
    // A JavaScript host — or a config still on the removed `agent`/`paint`
    // slots — would otherwise get a silently dropped model.
    expect(() => resolveModels({ models: { agent: "opus" } as never }, make))
      .toThrow(/models\.agent is not a model seat/);
    expect(() => resolveModels({ models: { paint: "haiku" } as never }, make))
      .toThrow(/models\.paint is not a model seat/);
  });
});
