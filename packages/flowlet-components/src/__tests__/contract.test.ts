import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { descriptors, prewiredComponents } from "../descriptors";
import { prewiredImpls } from "../impls";

describe("prewired contract", () => {
  it("every descriptor has exactly one impl and vice versa", () => {
    const descNames = descriptors.map((d) => d.name).sort();
    const implNames = Object.keys(prewiredImpls).sort();
    expect(implNames).toEqual(descNames);
  });

  it("all descriptors are stamped source=prewired", () => {
    expect(prewiredComponents.every((c) => c.source === "prewired")).toBe(true);
  });

  it("prewired names are globally unique", () => {
    const names = descriptors.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every props schema is JSON-Schema convertible", () => {
    for (const d of descriptors) {
      expect(() => zodToJsonSchema(d.propsSchema as never)).not.toThrow();
    }
  });

  it("the descriptors entrypoint exposes a non-empty descriptor array", async () => {
    const mod = await import("../descriptors");
    expect(Array.isArray(mod.descriptors)).toBe(true);
    expect(mod.descriptors.length).toBeGreaterThan(0);
  });
});
