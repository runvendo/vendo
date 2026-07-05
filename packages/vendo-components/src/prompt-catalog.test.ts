import { describe, it, expect } from "vitest";
import { z } from "zod";
import { componentPromptCatalog } from "./prompt-catalog.js";
import { hostComponent, toHostRegistry } from "./host-component.js";
import { prewiredComponents } from "./descriptors.js";

describe("componentPromptCatalog", () => {
  const registry = toHostRegistry([
    hostComponent(
      "AcmeBadge",
      "The app's own status pill.",
      z.object({ text: z.string(), variant: z.enum(["ok", "warn"]).optional() }),
    ),
  ]);

  it("renders one '- Name: description' line per component with a props hint", () => {
    const catalog = componentPromptCatalog(registry);
    expect(catalog).toBe("- AcmeBadge: The app's own status pill.  props: { text, variant? }");
  });

  it("marks optional props with '?' and required props bare", () => {
    const catalog = componentPromptCatalog(registry);
    expect(catalog).toContain("text, variant?");
    expect(catalog).not.toContain("text?");
  });

  it("omits the props hint for non-object schemas instead of throwing", () => {
    const weird = toHostRegistry([hostComponent("AcmeFree", "Anything goes.", z.unknown())]);
    expect(componentPromptCatalog(weird)).toBe("- AcmeFree: Anything goes.");
  });

  it("works for the full prewired catalog (every line has name + description)", () => {
    const lines = componentPromptCatalog(prewiredComponents).split("\n");
    expect(lines).toHaveLength(prewiredComponents.length);
    for (const line of lines) expect(line).toMatch(/^- [A-Z][A-Za-z0-9]*: .+/);
  });
});
