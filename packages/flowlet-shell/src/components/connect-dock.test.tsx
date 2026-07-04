import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ConnectDock } from "./ConnectDock";
import { ConnectTray } from "./ConnectTray";
import type { Integration } from "../seams/integrations";

// Deferred animate mock; reduced motion is controlled via a matchMedia stub.
const animateCalls: unknown[] = [];
vi.mock("motion", () => ({
  animate: (_el: unknown, kf: unknown) => {
    animateCalls.push(kf);
    return Promise.resolve();
  },
}));

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches, media: query }) as MediaQueryList);
}
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
  animateCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectDock", () => {
  it("shows a connected-count badge and toggles", () => {
    const onToggle = vi.fn();
    const { container, getByRole } = render(
      <ConnectDock integrations={tools} open={false} onToggle={onToggle} />,
    );
    const btn = getByRole("button", { name: /connect tools \(2 connected\)/i });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // The badge sits on the wrapper, outside the ripple's clip box, so the
    // count can overhang the button without being cut off.
    const badge = container.querySelector(".fl-dock > .fl-dock-badge");
    expect(badge?.textContent).toBe("2");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it("no badge when nothing is connected", () => {
    const { container } = render(
      <ConnectDock
        integrations={tools.map((t) => ({ ...t, connected: false }))}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(container.querySelector(".fl-dock-badge")).toBeNull();
  });
});

describe("ConnectTray", () => {
  it("renders children when open and nothing when closed (preference unknown → instant)", () => {
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

  it("animates open with motion allowed, instantly under reduced motion", () => {
    stubReducedMotion(false);
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
    expect(animateCalls.length).toBeGreaterThan(0);

    stubReducedMotion(true);
    const before = animateCalls.length;
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
    expect(animateCalls.length).toBe(before);
  });
});
