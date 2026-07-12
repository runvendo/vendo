import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { FluidReveal } from "./FluidReveal";
import type { FluidMotion } from "./fluid-motion";

// Controllable toolkit: each test decides availability / reduced-motion / how
// animations settle. The component only ever talks to this seam.
let toolkit: FluidMotion | null = null;

vi.mock("./fluid-motion", () => ({
  loadFluidMotion: () => Promise.resolve(toolkit),
  loadedFluidMotion: () => toolkit,
}));

function deferredAnimate() {
  const settlers: Array<() => void> = [];
  const calls: Array<{ target: unknown; keyframes: unknown }> = [];
  const animate = ((target: unknown, keyframes: unknown) => {
    calls.push({ target, keyframes });
    return new Promise<void>((resolve) => settlers.push(resolve));
  }) as unknown as FluidMotion["animate"];
  return { animate, calls, settle: () => settlers.splice(0).forEach((s) => s()) };
}

const skeleton = <div data-testid="skel">building…</div>;
const view = <div data-testid="view">the view</div>;

beforeEach(() => {
  toolkit = null;
});

describe("FluidReveal", () => {
  it("mounts statically in view phase — no exit layer, no animation", () => {
    const d = deferredAnimate();
    toolkit = { animate: d.animate, prefersReducedMotion: () => false };
    const { container, getByTestId } = render(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(getByTestId("view")).toBeTruthy();
    expect(container.querySelector(".fl-reveal-exit")).toBeNull();
    expect(d.calls.length).toBe(0);
  });

  it("swaps instantly when the toolkit is unavailable", () => {
    const { container, rerender, getByTestId, queryByTestId } = render(
      <FluidReveal phase="skeleton">{skeleton}</FluidReveal>,
    );
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(getByTestId("view")).toBeTruthy();
    expect(queryByTestId("skel")).toBeNull();
    expect(container.querySelector(".fl-reveal-exit")).toBeNull();
  });

  it("swaps instantly under reduced motion", () => {
    const d = deferredAnimate();
    toolkit = { animate: d.animate, prefersReducedMotion: () => true };
    const { container, rerender, getByTestId } = render(
      <FluidReveal phase="skeleton">{skeleton}</FluidReveal>,
    );
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(getByTestId("view")).toBeTruthy();
    expect(container.querySelector(".fl-reveal-exit")).toBeNull();
    expect(d.calls.length).toBe(0);
  });

  it("plays the fluid reveal on an observed skeleton→view flip, then settles", async () => {
    const d = deferredAnimate();
    toolkit = { animate: d.animate, prefersReducedMotion: () => false };
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
    expect(d.calls.length).toBe(3);
    d.settle();
    await waitFor(() => expect(container.querySelector(".fl-reveal-exit")).toBeNull());
    // Inline transition styles are released so the card returns to auto flow.
    const host = container.querySelector(".fl-reveal") as HTMLElement;
    expect(host.style.height).toBe("");
    expect(host.style.overflow).toBe("");
  });

  it("does not replay the reveal when the view re-renders", () => {
    const d = deferredAnimate();
    toolkit = { animate: d.animate, prefersReducedMotion: () => false };
    const { rerender } = render(<FluidReveal phase="skeleton">{skeleton}</FluidReveal>);
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    const callsAfterFlip = d.calls.length;
    rerender(<FluidReveal phase="view">{view}</FluidReveal>);
    expect(d.calls.length).toBe(callsAfterFlip);
  });
});
