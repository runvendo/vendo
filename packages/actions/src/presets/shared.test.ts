import { describe, expect, it } from "vitest";
import { TokenCache } from "./shared.js";

describe("TokenCache", () => {
  it("returns cached tokens inside the safety margin and drops them past it", () => {
    const cache = new TokenCache();
    cache.set("a", "token-a", 10_000, 0);

    expect(cache.get("a", 4_999, 5_000)).toBe("token-a");
    expect(cache.get("a", 5_000, 5_000)).toBeUndefined();
  });

  it("evicts expired entries on set so abandoned subjects cannot grow the cache unbounded", () => {
    const cache = new TokenCache();
    cache.set("stale-1", "t1", 1_000, 0);
    cache.set("stale-2", "t2", 2_000, 0);
    cache.set("live", "t3", 60_000, 0);

    // Both stale entries have expired; nobody ever calls get() for them again.
    cache.set("new", "t4", 120_000, 3_000);

    expect(cache.size).toBe(2);
    expect(cache.get("live", 3_000, 0)).toBe("t3");
    expect(cache.get("new", 3_000, 0)).toBe("t4");
    expect(cache.get("stale-1", 3_000, 0)).toBeUndefined();
    expect(cache.get("stale-2", 3_000, 0)).toBeUndefined();
  });
});
