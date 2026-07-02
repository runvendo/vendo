import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ConnectDock } from "./ConnectDock";
import { ConnectTray } from "./ConnectTray";
import type { FluidMotion } from "./fluid-motion";
import type { Integration } from "../seams/integrations";

let toolkit: FluidMotion | null = null;
vi.mock("./fluid-motion", () => ({
  loadFluidMotion: () => Promise.resolve(toolkit),
  loadedFluidMotion: () => toolkit,
}));
// The dock button's ripple is fluidkit-optional; keep it inert in tests.
vi.mock("./FluidRipple", () => ({
  FluidRipple: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const tools: Integration[] = [
  { id: "gmail", name: "Gmail", connected: true },
  { id: "slack", name: "Slack", connected: true },
  { id: "notion", name: "Notion", connected: false },
];

beforeEach(() => {
  toolkit = null;
});

describe("ConnectDock", () => {
  it("shows a connected-count badge and toggles", () => {
    const onToggle = vi.fn();
    const { getByRole } = render(
      <ConnectDock integrations={tools} open={false} onToggle={onToggle} />,
    );
    const btn = getByRole("button", { name: /connect tools/i });
    expect(btn.textContent).toContain("2");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it("no badge when nothing is connected", () => {
    const { getByRole } = render(
      <ConnectDock
        integrations={tools.map((t) => ({ ...t, connected: false }))}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(getByRole("button", { name: /connect tools/i }).querySelector(".fl-dock-badge")).toBeNull();
  });
});

describe("ConnectTray", () => {
  it("renders children when open and nothing when closed (toolkit absent → instant)", () => {
    const { container, rerender } = render(
      <ConnectTray open={false} onClose={vi.fn()}>
        <div data-testid="picker" />
      </ConnectTray>,
    );
    expect(container.querySelector(".fl-tray")).toBeNull();
    rerender(
      <ConnectTray open onClose={vi.fn()}>
        <div data-testid="picker" />
      </ConnectTray>,
    );
    expect(container.querySelector(".fl-tray")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConnectTray open onClose={onClose}>
        <div />
      </ConnectTray>,
    );
    fireEvent.keyDown(container.querySelector(".fl-tray")!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("animates open when the toolkit is present, instantly under reduced motion", () => {
    const calls: unknown[] = [];
    toolkit = {
      animate: ((el: unknown, kf: unknown) => {
        calls.push(kf);
        return Promise.resolve();
      }) as unknown as FluidMotion["animate"],
      prefersReducedMotion: () => false,
    };
    const { rerender } = render(
      <ConnectTray open={false} onClose={vi.fn()}>
        <div />
      </ConnectTray>,
    );
    rerender(
      <ConnectTray open onClose={vi.fn()}>
        <div />
      </ConnectTray>,
    );
    expect(calls.length).toBeGreaterThan(0);

    toolkit = { ...toolkit, prefersReducedMotion: () => true };
    const before = calls.length;
    const r2 = render(
      <ConnectTray open={false} onClose={vi.fn()}>
        <div />
      </ConnectTray>,
    );
    r2.rerender(
      <ConnectTray open onClose={vi.fn()}>
        <div />
      </ConnectTray>,
    );
    expect(calls.length).toBe(before);
  });
});
