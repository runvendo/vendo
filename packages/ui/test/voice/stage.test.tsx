// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VendoProvider } from "../../src/index.js";
import { VendoStage } from "../../src/voice/index.js";
import { ScriptedVoiceDriver } from "./fake-driver.js";

// This suite exercises VendoStage's behavior (controls, announced status,
// ordered transcript) — not fluidkit's animated presence, which is decorative
// and `aria-hidden`. The real `VoiceBall` pulls in `motion`, whose frameloop
// keeps a `requestAnimationFrame` perpetually outstanding. Under jsdom that rAF
// is backed by a Node `setInterval` that outlives vitest's environment teardown
// and then dereferences a stripped `window` — surfacing as unhandled
// "window is not defined" errors after the file passes. Mocking fluidkit with
// an inert stub keeps that async animation machinery out of the test entirely,
// which is both faithful (the ball is not under test) and deterministic.
vi.mock("fluidkit", () => ({
  VoiceBall: (props: { size?: number }) => (
    <span data-fluidkit="voice-ball-stub" style={{ width: props.size, height: props.size }} />
  ),
}));

describe("VendoStage", () => {
  it("controls the session and renders announced state and ordered transcript", () => {
    const driver = new ScriptedVoiceDriver();
    render(
      <VendoProvider voice={{ driver }}>
        <VendoStage />
      </VendoProvider>,
    );

    const start = screen.getByRole("button", { name: "Start voice" });
    expect(start.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(start);

    const stop = screen.getByRole("button", { name: "Stop voice" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("connecting");

    act(() => {
      driver.emit({ type: "state", state: "listening" });
      driver.emit({
        type: "transcript",
        entry: { id: "user-1", role: "user", text: "Show revenue", final: true },
      });
      driver.emit({
        type: "transcript",
        entry: { id: "assistant-1", role: "assistant", text: "Here it is", final: true },
      });
    });

    expect(screen.getByRole("status").textContent).toContain("listening");
    const transcript = screen.getByRole("list", { name: "Voice transcript" });
    const entries = within(transcript).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toContain("Show revenue");
    expect(entries[1]?.textContent).toContain("Here it is");

    fireEvent.click(stop);
    expect(screen.getByRole("button", { name: "Start voice" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("status").textContent).toContain("idle");
    expect(driver.stops).toBe(1);
  });
});
