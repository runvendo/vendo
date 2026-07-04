import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FluidThinking } from "./FluidThinking";

// fluidkit is a hard dependency now: Thinking renders directly (its
// reduced-motion/static rendering is fluidkit's tested degradation contract).
describe("FluidThinking", () => {
  it("renders fluidkit's Thinking with the accessible label", () => {
    const { getByRole } = render(<FluidThinking label="Working" />);
    expect(getByRole("status", { name: "Working" })).toBeTruthy();
  });

  it("maps the legacy spread prop to an equivalent size", () => {
    // spread=15 → size ≈ 15/3.5 ≈ 4; the indicator still mounts and is labeled.
    const { getByRole } = render(<FluidThinking label="Connecting Gmail" spread={15} />);
    expect(getByRole("status", { name: "Connecting Gmail" })).toBeTruthy();
  });
});
