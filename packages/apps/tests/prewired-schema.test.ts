import {
  KIT_SCREEN_COMPONENT_NAMES,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { wirePropNames } from "../src/server/escalation/prewired-schema.js";

describe("built-in prop names", () => {
  it("covers exactly the screen component names (no drift)", () => {
    expect([...wirePropNames.keys()].sort()).toEqual([...KIT_SCREEN_COMPONENT_NAMES].sort());
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

  it("carries Card, and the Tabs prop contract", () => {
    expect(wirePropNames.get("Card")?.has("title")).toBe(true);
    // A tabbed screen names {tabs, value} on its tab chrome; both must be
    // allowed or every tabbed app routes to repair.
    expect(wirePropNames.get("Tabs")?.has("tabs")).toBe(true);
    expect(wirePropNames.get("Tabs")?.has("value")).toBe(true);
  });
});
