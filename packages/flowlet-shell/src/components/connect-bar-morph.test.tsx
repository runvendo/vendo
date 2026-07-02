import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ConnectBarMorph } from "./ConnectBarMorph";
import type { FluidMotion } from "./fluid-motion";

let toolkit: FluidMotion | null = null;
vi.mock("./fluid-motion", () => ({
  loadFluidMotion: () => Promise.resolve(toolkit),
  loadedFluidMotion: () => toolkit,
}));

const bar = <div data-testid="bar">composer</div>;
const panel = <div data-testid="panel">picker</div>;

beforeEach(() => {
  toolkit = null;
});

describe("ConnectBarMorph", () => {
  it("shows the bar face closed and the panel face open (instant when toolkit absent)", () => {
    const { rerender, getByTestId, queryByTestId } = render(
      <ConnectBarMorph open={false} onClose={vi.fn()} bar={bar} panel={panel} />,
    );
    expect(getByTestId("bar")).toBeTruthy();
    expect(queryByTestId("panel")).toBeNull();
    rerender(<ConnectBarMorph open onClose={vi.fn()} bar={bar} panel={panel} />);
    expect(getByTestId("panel")).toBeTruthy();
    expect(queryByTestId("bar")).toBeNull();
  });

  it("morphs on toggle when the toolkit is present, and releases inline styles", async () => {
    const calls: unknown[] = [];
    toolkit = {
      animate: ((el: unknown, kf: unknown) => {
        calls.push(kf);
        return Promise.resolve();
      }) as unknown as FluidMotion["animate"],
      prefersReducedMotion: () => false,
    };
    const { container, rerender } = render(
      <ConnectBarMorph open={false} onClose={vi.fn()} bar={bar} panel={panel} />,
    );
    rerender(<ConnectBarMorph open onClose={vi.fn()} bar={bar} panel={panel} />);
    expect(calls.length).toBe(2); // height spring + face cross-fade
    const host = container.querySelector(".fl-barmorph") as HTMLElement;
    await waitFor(() => expect(host.style.height).toBe(""));
    expect(host.style.overflow).toBe("");
    // Morphing back animates again.
    rerender(<ConnectBarMorph open={false} onClose={vi.fn()} bar={bar} panel={panel} />);
    expect(calls.length).toBe(4);
  });

  it("stays instant under reduced motion and closes on Escape", () => {
    const calls: unknown[] = [];
    toolkit = {
      animate: ((el: unknown, kf: unknown) => {
        calls.push(kf);
        return Promise.resolve();
      }) as unknown as FluidMotion["animate"],
      prefersReducedMotion: () => true,
    };
    const onClose = vi.fn();
    const { container, rerender, getByTestId } = render(
      <ConnectBarMorph open={false} onClose={onClose} bar={bar} panel={panel} />,
    );
    rerender(<ConnectBarMorph open onClose={onClose} bar={bar} panel={panel} />);
    expect(getByTestId("panel")).toBeTruthy();
    expect(calls.length).toBe(0);
    fireEvent.keyDown(container.querySelector(".fl-barmorph")!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
