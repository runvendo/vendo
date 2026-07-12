// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VendoProvider } from "../../src/index.js";
import { VendoStage } from "../../src/voice/index.js";
import { ScriptedVoiceDriver } from "./fake-driver.js";

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
