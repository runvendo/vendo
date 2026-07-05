// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { mapleHostComponents, mapleHostDescriptors } from "./descriptors";
import { mapleHostImpls } from "./impls";

describe("Maple host-component registration", () => {
  it("every descriptor is registered with source 'host' and has a matching impl", () => {
    for (const c of mapleHostComponents) {
      expect(c.source).toBe("host");
      expect(mapleHostImpls[c.name as keyof typeof mapleHostImpls]).toBeTypeOf("function");
    }
    expect(Object.keys(mapleHostImpls)).toHaveLength(mapleHostDescriptors.length);
  });

  it("MapleSparkline renders the app's real SVG sparkline from JSON props", () => {
    const Impl = mapleHostImpls.MapleSparkline;
    const { container } = render(<Impl data={[1, 4, 2, 8, 5]} />);
    const svg = container.querySelector("svg polyline");
    expect(svg).not.toBeNull();
  });

  it("schema-invalid props render the contained fallback, never garbage into the host component", () => {
    const Impl = mapleHostImpls.MapleSparkline;
    render(<Impl data={[1]} />); // min(2) violated
    expect(screen.getByTestId("vendo-invalid-props")).toBeTruthy();
  });

  it("MapleSpendingDonut accepts the documented category ids", () => {
    const Impl = mapleHostImpls.MapleSpendingDonut;
    const { container } = render(
      <Impl slices={[{ category: "housing", amount: 2850 }, { category: "dining", amount: 87 }]} />,
    );
    expect(container.querySelector('[data-testid="vendo-invalid-props"]')).toBeNull();
  });
});
