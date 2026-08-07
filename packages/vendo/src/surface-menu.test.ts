import { describe, expect, it, vi } from "vitest";
import { memoizedSurfaceMenu } from "./surface-menu.js";

describe("memoizedSurfaceMenu", () => {
  it("resolves once and reuses the answer", async () => {
    const resolve = vi.fn(async () => ["host_a"]);
    const menu = memoizedSurfaceMenu(resolve, () => undefined);
    await expect(menu()).resolves.toEqual(new Set(["host_a"]));
    await expect(menu()).resolves.toEqual(new Set(["host_a"]));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("caches an unrestricted answer too", async () => {
    const resolve = vi.fn(async () => undefined);
    const menu = memoizedSurfaceMenu(resolve, () => undefined);
    await expect(menu()).resolves.toBeUndefined();
    await expect(menu()).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure: it warns with the cause and retries next time", async () => {
    const warnings: string[] = [];
    let attempt = 0;
    const resolve = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("overrides.json is unreadable");
      return ["host_a"];
    });
    const menu = memoizedSurfaceMenu(resolve, (line) => warnings.push(line));

    // Degrades to unrestricted rather than emptying the surface…
    await expect(menu()).resolves.toBeUndefined();
    // …loudly, naming the cause…
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("overrides.json is unreadable");
    // …and the next call tries again instead of being frozen unrestricted.
    await expect(menu()).resolves.toEqual(new Set(["host_a"]));
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
