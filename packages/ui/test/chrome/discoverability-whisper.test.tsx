// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { hasSeen } from "../../src/chrome/discoverability.js";

const client = createVendoClient({ baseUrl: "http://localhost:9" });

function renderOverlay(ui: React.ReactElement = <VendoOverlay />) {
  return render(<VendoProvider client={client}>{ui}</VendoProvider>);
}

const caption = () => screen.queryByText("You can reshape this app");
const launcher = () => screen.getByRole("button", { name: /vendo/i });

describe("whisper launcher (ui-usage-dx §6 — ambient discoverability)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("first eligible visit: pulses the pill, shows the caption, and marks seen immediately", () => {
    renderOverlay();
    expect(caption()).toBeTruthy();
    expect(launcher().hasAttribute("data-vendo-whisper")).toBe(true);
    // Seen is recorded on first RENDER (not on dismiss) so a reload
    // mid-animation can never replay the whisper.
    expect(hasSeen("whisper")).toBe(true);
  });

  it("never renders again across simulated reloads", () => {
    renderOverlay();
    expect(caption()).toBeTruthy();
    cleanup();
    // Fresh mount, same localStorage = a reload.
    renderOverlay();
    expect(caption()).toBeNull();
    expect(launcher().hasAttribute("data-vendo-whisper")).toBe(false);
  });

  it("auto-dismisses the caption after ~6 seconds", () => {
    vi.useFakeTimers();
    renderOverlay();
    expect(caption()).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(caption()).toBeNull();
  });

  it("discoverability=\"quiet\" disables it without burning the flag", () => {
    renderOverlay(<VendoOverlay discoverability="quiet" />);
    expect(caption()).toBeNull();
    expect(launcher().hasAttribute("data-vendo-whisper")).toBe(false);
    // A quiet visit is not an eligible visit: flipping the dial on later
    // still lets a user who has never seen the whisper see it once.
    expect(hasSeen("whisper")).toBe(false);
  });

  it("provider-level discoverability=\"quiet\" reaches the overlay", () => {
    render(
      <VendoProvider client={client} discoverability="quiet">
        <VendoOverlay />
      </VendoProvider>,
    );
    expect(caption()).toBeNull();
  });

  it("launcher=\"none\" renders no whisper at all (no orphan caption)", () => {
    renderOverlay(<VendoOverlay launcher="none" />);
    expect(caption()).toBeNull();
    expect(hasSeen("whisper")).toBe(false);
  });

  it("hides the caption once the overlay opens", () => {
    renderOverlay();
    expect(caption()).toBeTruthy();
    act(() => {
      launcher().click();
    });
    expect(caption()).toBeNull();
  });
});
