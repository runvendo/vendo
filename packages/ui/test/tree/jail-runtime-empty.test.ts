// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

describe("generated component jail empty render runtime", () => {
  it("reports an explicit empty result instead of ready for a null render", async () => {
    class FakeResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    await import("../../src/tree/jail/runtime-entry.js");
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: {
        vendo: true,
        kind: "render",
        source: "export default function Empty() { return null; }",
        props: {},
      },
    }));

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ vendo: true, kind: "empty" }, "*");
    });
    expect(postMessage).not.toHaveBeenCalledWith({ vendo: true, kind: "ready" }, "*");
  }, 15_000);
});
