import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import { OverlayPanel } from "../components/OverlayPanel";
import { VendoPage } from "./VendoPage";

/** jsdom has no matchMedia — stub one whose max-width query reports `mobile`.
 *  Every other query (e.g. prefers-reduced-motion) reports false, matching
 *  the shell's existing one-off matchMedia reads. */
function stubViewport(mobile: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width") ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Real surfaces (VendoOverlay, the slot's design overlay) always TRANSITION
 *  closed→open — the focus trap arms on that transition, so the test opens
 *  the same way instead of mounting pre-opened. */
function mountOverlay() {
  const ui = (open: boolean) => (
    <VendoShellProvider>
      <OverlayPanel open={open} onClose={() => {}} ariaLabel="Ask">
        <button type="button">inside</button>
      </OverlayPanel>
    </VendoShellProvider>
  );
  const view = render(ui(false));
  view.rerender(ui(true));
  return view;
}

describe("mobile takeover (<768px)", () => {
  it("the overlay panel presents full-screen below the breakpoint", () => {
    stubViewport(true);
    mountOverlay();
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("fl-takeover");
    // The close affordance stays reachable inside the takeover.
    expect(screen.getByLabelText("Close")).toBeTruthy();
    // The focus trap still lands focus on the content, not the document body.
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("the overlay panel keeps its centered-card presentation above the breakpoint", () => {
    stubViewport(false);
    mountOverlay();
    expect(screen.getByRole("dialog").className).not.toContain("fl-takeover");
  });

  it("the page element presents full-screen below the breakpoint, and not above", () => {
    stubViewport(true);
    const { container, unmount } = render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoPage agent={createStubAgent()} components={[]} />
      </VendoProvider>,
    );
    expect(container.querySelector(".fl-page")?.className).toContain("fl-takeover");
    unmount();

    stubViewport(false);
    const desktop = render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoPage agent={createStubAgent()} components={[]} />
      </VendoProvider>,
    );
    expect(desktop.container.querySelector(".fl-page")?.className).not.toContain("fl-takeover");
  });
});
