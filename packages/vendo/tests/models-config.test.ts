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

describe("resolveModels (the models block, one seat per job)", () => {
  it("zero config rides the ladder once per seat, each under its own slot", () => {
    const { made, make } = scriptedMake();
    const resolved = resolveModels({}, make);
    expect(resolved.agent.venue).toBe("ladder");
    expect(made).toEqual([
      { name: undefined, slot: "agent" },
      { name: undefined, slot: "apps" },
      { name: undefined, slot: "review" },
      { name: undefined, slot: "judge" },
    ]);
  });

  it("models.default as a string resolves through the ladder; as an object it wins as-is", () => {
    const { made, make } = scriptedMake();
    const viaString = resolveModels({ models: { default: "claude-opus-4-8" } }, make);
    expect(viaString.agent.venue).toBe("ladder");
    expect(made[0]).toEqual({ name: "claude-opus-4-8", slot: "agent" });
    // A string-configured default still rides the ladder, so the other seats
    // keep their own per-slot picks.
    expect(viaString.seats.apps).toEqual(expect.objectContaining({ slot: "apps" }));

    const object = explicitModel("byo");
    const viaObject = resolveModels({ models: { default: object } }, scriptedMake().make);
    expect(viaObject.agent).toEqual({ model: object, venue: "custom" });
  });

  it("every unset seat borrows an explicitly passed default object", () => {
    const { made, make } = scriptedMake();
    const object = explicitModel("byo");
    const resolved = resolveModels({ models: { default: object } }, make);
    expect(resolved.seats).toEqual({ default: object, apps: object, review: object, judge: object });
    // Nothing rode the ladder: an explicit model is the host's whole answer.
    expect(made).toEqual([]);
  });

  it("an explicit seat wins over the borrowed default, string or object", () => {
    const { made, make } = scriptedMake();
    const preferred = explicitModel("preferred-review");
    const resolved = resolveModels(
      { models: { default: explicitModel("byo"), apps: "claude-haiku-4-5", review: preferred } },
      make,
    );
    expect(resolved.seats.apps).toEqual(expect.objectContaining({ name: "claude-haiku-4-5", slot: "apps" }));
    expect(resolved.seats.review).toBe(preferred);
    expect(made).toEqual([{ name: "claude-haiku-4-5", slot: "apps" }]);
  });

  it("rejects non-string non-object seat values and blank strings with a validation error", () => {
    const { make } = scriptedMake();
    expect(() => resolveModels({ models: { default: 5 as unknown as string } }, make)).toThrow(VendoError);
    expect(() => resolveModels({ models: { apps: "   " } }, make)).toThrow(VendoError);
    expect(() => resolveModels({ models: { judge: null as unknown as string } }, make)).toThrow(VendoError);
  });

  it("refuses a models key that is not a seat instead of ignoring it", () => {
    const { make } = scriptedMake();
    // A JavaScript host — or a config still on the removed `agent`/`paint`/
    // `fill`/`reviewer` spellings — would otherwise get a silently dropped model.
    expect(() => resolveModels({ models: { agent: "opus" } as never }, make))
      .toThrow(/models\.agent is not a model seat/);
    expect(() => resolveModels({ models: { fill: "haiku" } as never }, make))
      .toThrow(/models\.fill is not a model seat/);
  });
});
