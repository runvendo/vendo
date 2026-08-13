// @vitest-environment node
// F10 — the last-thread store must be inert without a window (SSR, workers):
// reads answer undefined, writes never throw. Mirrors
// discoverability-store-ssr.test.ts.
import { describe, expect, it } from "vitest";
import { forgetThread, lastThreadId, rememberThread } from "../../src/chrome/last-thread.js";

describe("last-thread store without a window", () => {
  it("reads undefined and writes are inert", () => {
    expect(lastThreadId()).toBeUndefined();
    expect(() => rememberThread("thr_x")).not.toThrow();
    expect(() => forgetThread()).not.toThrow();
  });
});
