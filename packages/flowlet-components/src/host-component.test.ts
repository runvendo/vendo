import { describe, it, expect } from "vitest";
import { z } from "zod";
import { hostComponent } from "./host-component";
import { RESERVED_COMPONENT_NAMES } from "@flowlet/core";

describe("hostComponent", () => {
  const schema = z.object({ data: z.array(z.number()).min(1) });

  it("returns a RegisteredComponent with source 'host'", () => {
    const d = hostComponent("Sparkline", "A tiny line chart.", schema);
    expect(d.toRegistered()).toMatchObject({
      name: "Sparkline",
      description: "A tiny line chart.",
      source: "host",
    });
  });

  it("rejects non-PascalCase names (the genui format requires them)", () => {
    expect(() => hostComponent("sparkline", "x", schema)).toThrow(/PascalCase/);
    expect(() => hostComponent("spark-line", "x", schema)).toThrow(/PascalCase/);
  });

  it("rejects names that shadow a reserved primitive", () => {
    for (const name of RESERVED_COMPONENT_NAMES) {
      expect(() => hostComponent(name, "x", schema)).toThrow(/reserved/);
    }
  });

  it("rejects an empty agent-facing description — the docs ARE the API", () => {
    expect(() => hostComponent("Sparkline", "", schema)).toThrow(/description/);
  });
});
