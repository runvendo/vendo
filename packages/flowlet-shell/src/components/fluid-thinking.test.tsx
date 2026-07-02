import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FluidThinking } from "./FluidThinking";

describe("FluidThinking (fluidkit present)", () => {
  it("renders the static-dot fallback immediately, then upgrades to the fluid indicator", async () => {
    const { container } = render(<FluidThinking />);
    // First paint must not wait on the dynamic import — the legacy dots show.
    expect(container.querySelector(".fl-typing")).toBeTruthy();
    // Once fluidkit loads, its Thinking primitive takes over (role=status).
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(container.querySelector(".fl-thinking")).toBeTruthy();
    expect(container.querySelector(".fl-typing")).toBeNull();
  });

  it("passes the accessible label through in both phases", async () => {
    const { container } = render(<FluidThinking label="Generating" />);
    expect(container.querySelector('[aria-label="Generating"]')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Generating");
  });
});
