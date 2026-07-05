/**
 * Boot-failure recovery: a transient assembly failure (storage blip at first
 * request) must not be memoized — the next request retries and succeeds.
 * Isolated in its own file because it mocks ./storage module-wide.
 */
import { describe, expect, it, vi } from "vitest";

const resolveStorage = vi.hoisted(() => vi.fn());
vi.mock("./storage", () => ({ resolveStorage }));

import { createVendoFetchHandler } from "./fetch-handler.js";

describe("assembly failure eviction", () => {
  it("retries assembly after a transient boot failure instead of caching the rejection", async () => {
    resolveStorage.mockRejectedValueOnce(new Error("transient boot blip")).mockResolvedValue(null);
    const handler = createVendoFetchHandler({ automations: false });
    const req = () => new Request("http://localhost/api/vendo/capabilities");

    // Boot failures surface as a 500 JSON error (never an unhandled rejection).
    const first = await handler(req());
    expect(first.status).toBe(500);
    expect(((await first.json()) as { error: string }).error).toMatch(/transient boot blip/);

    const second = await handler(req());
    expect(second.status).toBe(200);
    expect(resolveStorage).toHaveBeenCalledTimes(2);
  });
});
