import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { FluidReveal } from "./FluidReveal";

// Deferred animate mock: each test controls when animations settle.
const settlers: Array<() => void> = [];
const calls: Array<{ target: unknown; keyframes: unknown }> = [];
vi.mock("motion", () => ({
  animate: (target: unknown, keyframes: unknown) => {
    calls.push({ target, keyframes });
    return new Promise<void>((resolve) => settlers.push(resolve));
  },
}));

/** Reduced motion is read via matchMedia + fluidkit's resolver; stub it per test. */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches, media: query }) as MediaQueryList);
}

const skeleton = <div data-testid="skel">building…</div>;
const view = <div data-testid="view">the view</div>;

beforeEach(() => {
  settlers.length = 0;
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FluidReveal", () => {
  it("mounts statically in view phase — no exit layer, no animation", () => {
    stubReducedMotion(false);
    const { container, getByTestId } = render(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(getByTestId("view")).toBeTruthy();
    expect(container.querySelector(".fl-reveal-exit")).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("swaps instantly when the reduced-motion preference is unknown (static-safe)", () => {
    // No matchMedia stub: jsdom without matchMedia reads as unknown → reduced.
    const { container, rerender, getByTestId, queryByTestId } = render(
      <FluidReveal phase="skeleton">{skeleton}</FluidReveal>,
    );
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(getByTestId("view")).toBeTruthy();
    expect(queryByTestId("skel")).toBeNull();
    expect(container.querySelector(".fl-reveal-exit")).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("swaps instantly under reduced motion", () => {
    stubReducedMotion(true);
    const { container, rerender, getByTestId } = render(
      <FluidReveal phase="skeleton">{skeleton}</FluidReveal>,
    );
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(getByTestId("view")).toBeTruthy();
    expect(container.querySelector(".fl-reveal-exit")).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("plays the fluid reveal on an observed skeleton→view flip, then settles", async () => {
    stubReducedMotion(false);
    const { container, rerender, getByTestId } = render(
      <FluidReveal phase="skeleton">{skeleton}</FluidReveal>,
    );
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    // Mid-transition: the old skeleton hangs on as an exiting overlay while
    // the view is already mounted, and animations were kicked off (container
    // height, entering layer, exiting layer).
    const exit = container.querySelector(".fl-reveal-exit");
    expect(exit).toBeTruthy();
    expect(exit!.textContent).toContain("building…");
    expect(exit!.getAttribute("aria-hidden")).toBe("true");
    expect(getByTestId("view")).toBeTruthy();
    expect(calls.length).toBe(3);
    settlers.splice(0).forEach((s) => s());
    await waitFor(() => expect(container.querySelector(".fl-reveal-exit")).toBeNull());
    // Inline transition styles are released so the card returns to auto flow.
    const host = container.querySelector(".fl-reveal") as HTMLElement;
    expect(host.style.height).toBe("");
    expect(host.style.overflow).toBe("");
  });

  it("does not replay the reveal when the view re-renders", () => {
    stubReducedMotion(false);
    const { rerender } = render(<FluidReveal phase="skeleton">{skeleton}</FluidReveal>);
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    const callsAfterFlip = calls.length;
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(calls.length).toBe(callsAfterFlip);
  });
});
