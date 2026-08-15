// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "../../src/kit/icon.js";
import { ICON_NAMES, ICON_PATHS } from "../../src/kit/icons.gen.js";

describe("ICON_NAMES", () => {
  it("carries the whole common vocabulary, and only markup", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(180);
    expect(ICON_NAMES.length).toBeLessThan(280);
    for (const name of ICON_NAMES) {
      expect(name, `${name} is not kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ICON_PATHS[name], name).toMatch(/^<[a-z]+ /);
    }
    for (const required of ["chevron-right", "alert-triangle", "credit-card", "trending-up", "eye-off"]) {
      expect(ICON_NAMES, `missing ${required}`).toContain(required);
    }
  });
});

describe("Icon", () => {
  it("renders the glyph's markup, decorative by default", () => {
    const { container } = render(<Icon name="check" size={20} />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("path")).toBeTruthy();
  });

  it("names itself for a screen reader when labelled", () => {
    const { container } = render(<Icon name="check" label="Done" />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Done");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });

  it("paints a tone and leaves neutral to the surrounding text", () => {
    expect(render(<Icon name="check" tone="danger" />).container.querySelector("svg")?.getAttribute("style"))
      .toContain("color:");
    expect(render(<Icon name="check" />).container.querySelector("svg")?.getAttribute("style"))
      .not.toContain("color:");
  });

  it("renders nothing but a marker for a name it does not have", () => {
    for (const name of ["not-an-icon", "constructor", undefined]) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector("svg")).toBeNull();
      expect(container.querySelector("[data-kit-missing-icon]")).toBeTruthy();
    }
  });
});
