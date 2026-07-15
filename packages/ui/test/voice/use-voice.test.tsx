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
    expect(result.current.error).toBeNull();
    expect(result.current.muted).toBe(false);
    expect(result.current.amplitude).toBe(0);
    expect(result.current.views).toEqual([]);
    act(() => result.current.start());
    act(() => result.current.setMuted(true));
    expect(result.current.state).toBe("unavailable");
    expect(result.current.muted).toBe(false);
  });

  it("preserves transcript entries while the driver reconnects", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.start());
    act(() => {
      driver.emit({
        type: "transcript",
        entry: { id: "line-1", role: "user", text: "Keep this", final: true },
      });
      driver.emit({ type: "state", state: "reconnecting" });
    });

    expect(result.current.state).toBe("reconnecting");
    expect(result.current.transcript).toEqual([
      { id: "line-1", role: "user", text: "Keep this", final: true },
    ]);

    act(() => driver.emit({ type: "state", state: "listening" }));
    expect(result.current.state).toBe("listening");
    expect(result.current.transcript).toHaveLength(1);
  });

  it("forwards mute to a live session and resets it on a new start", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.setMuted(true));
    expect(result.current.muted).toBe(false);

    act(() => result.current.start());
    act(() => result.current.setMuted(true));
    expect(result.current.muted).toBe(true);
    expect(driver.muted).toEqual([true]);

    act(() => result.current.stop());
    act(() => result.current.start());
    expect(result.current.muted).toBe(false);
  });

  it("exposes amplitude events and resets the level on stop and error", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.start());
    act(() => driver.emit({ type: "amplitude", level: 0.62 }));
    expect(result.current.amplitude).toBe(0.62);

    act(() => result.current.stop());
    expect(result.current.amplitude).toBe(0);

    act(() => result.current.start());
    act(() => driver.emit({ type: "amplitude", level: 0.48 }));
    act(() => driver.emit({ type: "error", error: { message: "connection lost" } }));
    expect(result.current.amplitude).toBe(0);
  });

  it("deduplicates session views by id and replaces an existing payload", () => {
    const driver = new ScriptedVoiceDriver();
    const { result } = renderHook(() => useVoice(), { wrapper: providerWith(driver) });

    act(() => result.current.start());
    act(() => {
      driver.emit({
        type: "view",
        view: { id: "view-1", appId: "app_1", payload: { formatVersion: "vendo-genui/v1", title: "First" } },
      });
      driver.emit({
        type: "view",
        view: { id: "view-2", appId: "app_2", payload: { formatVersion: "vendo-genui/v1", title: "Second" } },
      });
      driver.emit({
        type: "view",
        view: { id: "view-1", appId: "app_1", payload: { formatVersion: "vendo-genui/v1", title: "Updated" } },
      });
    });

    expect(result.current.views).toEqual([
      { id: "view-1", appId: "app_1", payload: { formatVersion: "vendo-genui/v1", title: "Updated" } },
      { id: "view-2", appId: "app_2", payload: { formatVersion: "vendo-genui/v1", title: "Second" } },
    ]);

    act(() => driver.emit({ type: "state", state: "reconnecting" }));
    expect(result.current.views).toHaveLength(2);
    act(() => result.current.stop());
    act(() => result.current.start());
    expect(result.current.views).toEqual([]);
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
    expect(result.current.error).toEqual({ message: "microphone denied" });
    expect(driver.stops).toBe(1);

    act(() => result.current.start());
    expect(result.current.state).toBe("connecting");
    expect(result.current.error).toBeNull();
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
