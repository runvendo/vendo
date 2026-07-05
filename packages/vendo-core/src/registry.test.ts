import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createRegistry } from "./registry.js";

describe("component registry", () => {
  it("registers and resolves by name", () => {
    const reg = createRegistry([
      { name: "Card", description: "a card", propsSchema: z.object({}), source: "prewired" },
    ]);
    expect(reg.get("Card")?.source).toBe("prewired");
    expect(reg.get("Missing")).toBeUndefined();
    expect(reg.list().map((c) => c.name)).toEqual(["Card"]);
  });
});
