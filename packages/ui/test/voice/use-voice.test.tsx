// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { VendoProvider } from "../../src/index.js";
import { useVoice } from "../../src/voice/index.js";
import { ScriptedVoiceDriver } from "./fake-driver.js";

describe("useVoice", () => {
  it("fails soft when no driver is configured", () => {
    const { result } = renderHook(() => useVoice(), { wrapper: ProviderWithoutVoice });

    expect(result.current.state).toBe("unavailable");
    act(() => result.current.start());
    expect(result.current.state).toBe("unavailable");
  });

  it("tracks state and updates transcript entries in place", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.start());
    expect(result.current.state).toBe("connecting");

    act(() => driver.emit({ type: "state", state: "listening" }));
    expect(result.current.state).toBe("listening");

    act(() => {
      driver.emit({
        type: "transcript",
        entry: { id: "line-1", role: "user", text: "Hel", final: false },
      });
      driver.emit({
        type: "transcript",
        entry: { id: "line-1", role: "user", text: "Hello", final: true },
      });
    });
    expect(result.current.transcript).toEqual([
      { id: "line-1", role: "user", text: "Hello", final: true },
    ]);

    act(() => driver.emit({
      type: "transcript",
      entry: { id: "line-1", role: "user", text: "late update", final: false },
    }));
    expect(result.current.transcript[0]?.text).toBe("Hello");
  });

  it("stops once, ignores a second start while active, and returns to idle", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => {
      result.current.start();
      result.current.start();
    });
    expect(driver.starts).toBe(1);

    act(() => result.current.stop());
    expect(driver.stops).toBe(1);
    expect(result.current.state).toBe("idle");
  });

  it("stops an active session on unmount", () => {
    const driver = new ScriptedVoiceDriver();
    const { result, unmount } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.start());
    unmount();

    expect(driver.stops).toBe(1);
  });

  it("moves to error and tears down when the driver reports a failure", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.start());
    act(() => driver.emit({ type: "error", error: { message: "microphone denied" } }));

    expect(result.current.state).toBe("error");
    expect(driver.stops).toBe(1);
  });
});

function ProviderWithoutVoice({ children }: { children: ReactNode }) {
  return <VendoProvider>{children}</VendoProvider>;
}

function providerWith(driver: ScriptedVoiceDriver) {
  return function ProviderWithVoice({ children }: { children: ReactNode }) {
    return <VendoProvider voice={{ driver }}>{children}</VendoProvider>;
  };
}
