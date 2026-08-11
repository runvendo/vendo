/**
 * The engine load, PROBED — the one seam where a stub is the subject rather than
 * a shortcut.
 *
 * `@vendoai/ui` and `@vendoai/apps` are separately published packages, so a host
 * can legitimately hold a `ui` that speaks screens over an `apps` that does not.
 * That version pair cannot be built out of this repo's own workspace, so the only
 * way to run the probe is to stand in for the older package. Every other test of
 * this bridge (./screen-bridge.test.tsx) runs the real engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const loadWith = async (door: Record<string, unknown>): Promise<typeof import("../../src/tree/screen-engine.js")> => {
  vi.resetModules();
  vi.doMock("@vendoai/apps/contract", () => door);
  return import("../../src/tree/screen-engine.js");
};

afterEach(() => {
  vi.doUnmock("@vendoai/apps/contract");
  vi.resetModules();
});

describe("loadScreenEngine", () => {
  it("says the build carries no screen engine, rather than a TypeError on the first click", async () => {
    // An `apps` from before the screen engine: the door is there, the engine is not.
    const { loadScreenEngine } = await loadWith({
      validateTree: () => undefined,
      bootScreen: undefined,
      flattenTree: undefined,
      warmScreenEngine: undefined,
    });

    await expect(loadScreenEngine()).rejects.toThrow("this build of @vendoai/apps carries no screen engine");
  });

  it("warms the engine before handing it over, because bootScreen is synchronous", async () => {
    const warmed: string[] = [];
    const { loadScreenEngine } = await loadWith({
      bootScreen: () => undefined,
      flattenTree: () => undefined,
      warmScreenEngine: async () => { warmed.push("warm"); },
    });

    const engine = await loadScreenEngine();

    // The WASM behind `bootScreen` loads asynchronously, so the warm-up happens
    // here — otherwise the first boot throws "not warm yet" into a notice.
    expect(warmed).toEqual(["warm"]);
    expect(typeof engine.bootScreen).toBe("function");
    expect(typeof engine.flattenTree).toBe("function");
  });

  it("accepts a door with no warm-up to await", async () => {
    const { loadScreenEngine } = await loadWith({
      bootScreen: () => undefined,
      flattenTree: () => undefined,
      warmScreenEngine: undefined,
    });

    await expect(loadScreenEngine()).resolves.toBeTruthy();
  });
});
