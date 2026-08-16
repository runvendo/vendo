import { describe, expect, it } from "vitest";
import { kitPrompt } from "../../../src/contract/kit/kit-prompt.js";
import { validateProps } from "../../../src/contract/kit/schema.js";
import { KIT_SPECS, kitSpec } from "../../../src/contract/kit/specs.js";

/**
 * The specs' half of passthrough styling: `style` everywhere, and the engine a
 * component wraps named on the spec — the single fact the prompt, the wire's
 * allowed-prop set and the screen typings all read to admit an engine's own
 * props. A component whose engine is unnamed here is a component whose
 * `stroke=` is a blocking error, so the naming is the whole feature.
 */
describe("passthrough styling in the specs", () => {
  it("gives every component a style prop, classed config", () => {
    for (const spec of KIT_SPECS) {
      expect(spec.props.style?.cls, spec.name).toBe("config");
    }
  });

  it("takes a CSS record and refuses a bare string", () => {
    const stack = kitSpec("Stack")!;
    expect(validateProps(stack, { style: { borderRadius: 12, color: "#FF3B30" } }).success).toBe(true);
    expect(validateProps(stack, { style: "color: red" }).success).toBe(false);
  });

  it("names recharts on the charts and Base UI on the components built from it", () => {
    for (const name of ["LineChart", "BarChart", "DonutChart", "Sparkline"]) {
      expect(kitSpec(name)?.engine, name).toBe("recharts");
    }
    for (const name of ["Input", "Tabs", "Menu", "Toast", "Modal", "Slider"]) {
      expect(kitSpec(name)?.engine, name).toBe("Base UI");
    }
  });

  it("leaves a component that wraps nothing without an engine, so a typo stays an error", () => {
    for (const name of ["Stack", "Text", "DataTable", "Button", "Select"]) {
      expect(kitSpec(name)?.engine, name).toBeUndefined();
    }
  });

  it("carries per-series engine props through a chart's series descriptors", () => {
    const line = kitSpec("LineChart")!;
    const props = { data: [], xKey: "month", series: [{ key: "revenue", label: "Revenue", stroke: "#FF3B30" }] };
    const result = validateProps(line, props);
    // Parsed THROUGH, not stripped: a zod object drops what it does not declare,
    // and a dropped color is a series that paints from the theme anyway. A
    // refusal fails here too — `false` matches no object.
    expect(result.success && result.data.series[0]).toMatchObject({ stroke: "#FF3B30" });
  });
});

describe("what the model is told", () => {
  const prompt = kitPrompt();

  it("teaches the theme as the default and the two escape hatches, with the upgrade posture", () => {
    expect(prompt).toContain("`style`");
    expect(prompt).toContain('<Sparkline stroke="#FF3B30"/>');
    expect(prompt).toContain("no compatibility promise");
  });

  it("names the engine on the components that have one, and only there", () => {
    expect(kitPrompt({ only: ["Sparkline"] })).toContain("plus any `recharts` prop");
    expect(kitPrompt({ only: ["Input"] })).toContain("plus any `Base UI` prop");
    expect(kitPrompt({ only: ["DataTable"] })).not.toContain("passed straight through");
  });

  it("teaches style once in the preamble rather than on all fifty components", () => {
    expect(kitPrompt({ only: ["DataTable"], omitPreamble: true })).not.toContain("`style`");
  });
});
