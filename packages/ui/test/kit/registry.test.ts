import { describe, expect, it } from "vitest";
import { KIT_COMPONENTS, KIT_SPECS, kitComponentNames } from "../../src/kit/registry.js";
import { kitPrompt } from "../../src/kit/kit-prompt.js";
import { propsSchema } from "../../src/kit/schema.js";

describe("KIT registry", () => {
  it("registers a React component for every spec, and vice versa", () => {
    for (const spec of KIT_SPECS) {
      expect(KIT_COMPONENTS[spec.name], `component missing for ${spec.name}`).toBeTypeOf("function");
    }
    expect(Object.keys(KIT_COMPONENTS).sort()).toEqual([...kitComponentNames()].sort());
  });

  it("has no duplicate names and covers the floor + adopted extras", () => {
    const names = KIT_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of [
      "Stack", "Row", "Grid", "Surface", "Divider",
      "Text", "Money", "DateTime", "Percent", "Num", "EnumBadge",
      "DataTable", "CardList", "Stat", "Badge",
      "LineChart", "BarChart", "DonutChart", "Sparkline", "Progress",
      "Input", "Select", "DatePicker", "Form", "Button", "Disclaimer",
      "Tabs", "Callout", "Accordion", "Checkbox", "Textarea",
    ]) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });

  it("classes every prop config | copy | data with a doc", () => {
    for (const spec of KIT_SPECS) {
      for (const [name, prop] of Object.entries(spec.props)) {
        expect(["config", "copy", "data"], `${spec.name}.${name}`).toContain(prop.cls);
        expect(prop.doc.length, `${spec.name}.${name} doc`).toBeGreaterThan(0);
      }
      expect(spec.examples.length, `${spec.name} examples`).toBeGreaterThan(0);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
  });

  it("builds a valid zod schema for each spec", () => {
    for (const spec of KIT_SPECS) {
      expect(() => propsSchema(spec)).not.toThrow();
    }
  });
});

describe("kitPrompt()", () => {
  const prompt = kitPrompt();

  it("renders every component name", () => {
    for (const spec of KIT_SPECS) {
      expect(prompt).toContain(`<${spec.name}`);
    }
  });

  it("marks prop classes and the law-1 data rule", () => {
    expect(prompt).toMatch(/config/);
    expect(prompt).toMatch(/copy/);
    expect(prompt).toMatch(/data/);
    expect(prompt.toLowerCase()).toContain("tool");
  });

  it("includes canonical examples and money-takes-cents guidance", () => {
    expect(prompt).toContain("Money");
    expect(prompt.toLowerCase()).toContain("cents");
  });

  it("can scope to a subset of components", () => {
    const scoped = kitPrompt({ only: ["DataTable", "Money"] });
    expect(scoped).toContain("<DataTable");
    expect(scoped).toContain("<Money");
    expect(scoped).not.toContain("<Accordion");
  });
});
