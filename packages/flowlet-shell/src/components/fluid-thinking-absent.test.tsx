import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { FluidThinking } from "./FluidThinking";

// Motion is an enhancement layer: when fluidkit can't load (not installed,
// bundler excluded it, network chunk failed), the shell must keep the legacy
// static dots and never crash.
vi.mock("fluidkit", () => {
  throw new Error("fluidkit unavailable");
});

describe("FluidThinking (fluidkit absent)", () => {
  it("keeps the static-dot indicator when the import fails", async () => {
    const { container } = render(<FluidThinking />);
    expect(container.querySelector(".fl-typing")).toBeTruthy();
    // Give the rejected import a tick to settle — the fallback must survive it.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".fl-typing")).toBeTruthy();
    expect(container.querySelector(".fl-thinking")).toBeNull();
    expect(container.querySelector('[aria-label="Working"]')).toBeTruthy();
  });
});
