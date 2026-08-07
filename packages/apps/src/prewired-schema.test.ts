import { KIT_WIRE_COMPONENT_NAMES } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { wirePropNames } from "./prewired-schema.js";

describe("wire built-in prop names", () => {
  it("covers exactly the wire component names (no drift)", () => {
    expect([...wirePropNames.keys()].sort()).toEqual([...KIT_WIRE_COMPONENT_NAMES].sort());
  });

  it("carries the real, bug-prone prop names", () => {
    // The regression set the legacy prewired schema existed for: every one of
    // these is a name the model reaches for from React convention and gets
    // wrong. The Kit specs carry the same props, so the pins survive the
    // family retirement — with DataTable in Table's place.
    expect(wirePropNames.get("DataTable")?.has("rows")).toBe(true);
    expect(wirePropNames.get("DataTable")?.has("data")).toBe(false);
    expect(wirePropNames.get("Button")?.has("onClick")).toBe(true);
    expect(wirePropNames.get("Button")?.has("onPress")).toBe(false);
    expect(wirePropNames.get("Select")?.has("options")).toBe(true);
    expect(wirePropNames.get("Select")?.has("labelKey")).toBe(false);
  });

  it("carries Card, and the Tabs wire contract the plan skeleton emits", () => {
    expect(wirePropNames.get("Card")?.has("title")).toBe(true);
    // skeleton.ts writes {tabs, value} on its tab-chrome node; both must be
    // allowed or every tabbed app routes to repair.
    expect(wirePropNames.get("Tabs")?.has("tabs")).toBe(true);
    expect(wirePropNames.get("Tabs")?.has("value")).toBe(true);
  });
});
