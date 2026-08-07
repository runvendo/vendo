// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (document.documentElement as unknown as { scrollHeight?: number }).scrollHeight;
  document.body.replaceChildren();
});

describe("generated component jail resize runtime", () => {
  it("reports the mount content height as it grows and shrinks, independent of the frame height", async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    let contentHeight = 1_400;
    let frameHeight = 150;
    const observed: Element[] = [];

    class FakeResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.id !== "vendo-jail-root") return DOMRect.fromRect();
      const generatedRoot = this.firstElementChild as HTMLElement | null;
      const viewportConstraintIsNeutralized = generatedRoot !== null
        && !generatedRoot.style.minHeight.includes("vh");
      return DOMRect.fromRect({ height: viewportConstraintIsNeutralized ? contentHeight : frameHeight + 40 });
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      get: () => 8_192,
    });
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    await import("../../src/tree/jail/runtime-entry.js");
    const generatedRoot = document.createElement("section");
    generatedRoot.style.minHeight = "100vh";
    generatedRoot.style.paddingBottom = "40px";
    document.querySelector("#vendo-jail-root")!.appendChild(generatedRoot);
    expect(resizeCallback).toBeTypeOf("function");
    expect(observed.map(element => element.id)).toEqual(["vendo-jail-root"]);
    postMessage.mockClear();

    resizeCallback!([], {} as ResizeObserver);
    expect(postMessage).toHaveBeenLastCalledWith({ vendo: true, kind: "resize", height: 1_400 }, "*");

    frameHeight = 1_400;
    contentHeight = 280;
    resizeCallback!([], {} as ResizeObserver);
    expect(postMessage).toHaveBeenLastCalledWith({ vendo: true, kind: "resize", height: 280 }, "*");
  }, 15_000);
});
