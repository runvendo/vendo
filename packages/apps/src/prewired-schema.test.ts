import { PREWIRED_COMPONENT_NAMES } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { PREWIRED_SCHEMAS, prewiredPropNames } from "./prewired-schema.js";

describe("prewired schema", () => {
  it("covers exactly the prewired component names (no drift)", () => {
    const declared = new Set(Object.keys(PREWIRED_SCHEMAS));
    const canonical = new Set<string>(PREWIRED_COMPONENT_NAMES);
    expect([...declared].sort()).toEqual([...canonical].sort());
  });

  it("carries the real, bug-prone prop names", () => {
    expect(prewiredPropNames.get("Table")?.has("rows")).toBe(true);
    expect(prewiredPropNames.get("Table")?.has("data")).toBe(false);
    expect(prewiredPropNames.get("Button")?.has("onClick")).toBe(true);
    expect(prewiredPropNames.get("Button")?.has("onPress")).toBe(false);
    expect(prewiredPropNames.get("Select")?.has("options")).toBe(true);
    expect(prewiredPropNames.get("Select")?.has("labelKey")).toBe(false);
  });
});
