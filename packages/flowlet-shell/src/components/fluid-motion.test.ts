import { describe, it, expect, vi } from "vitest";

// The loader resolves the motion toolkit once and caches the outcome; a failed
// load resolves null (the enhancement layer simply stays off) and never throws.
vi.mock("fluidkit", () => {
  throw new Error("fluidkit unavailable");
});
vi.mock("motion", () => {
  throw new Error("motion unavailable");
});

describe("loadFluidMotion (libs absent)", () => {
  it("resolves null instead of throwing when the imports fail", async () => {
    const { loadFluidMotion } = await import("./fluid-motion");
    await expect(loadFluidMotion()).resolves.toBeNull();
    // Cached: second call is the same settled promise, still null.
    await expect(loadFluidMotion()).resolves.toBeNull();
  });
});
