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
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveStorage.mockRejectedValueOnce(new Error("transient boot blip")).mockResolvedValue(null);
    const handler = createVendoFetchHandler({ automations: false });
    const req = () => new Request("http://localhost/api/vendo/capabilities");

    // Boot failures surface as a 500 JSON error (never an unhandled rejection)
    // whose body is GENERIC — a raw assembly error can carry file paths or
    // DATABASE_URL contents, so the detail goes to the server log only.
    const first = await handler(req());
    expect(first.status).toBe(500);
    expect(((await first.json()) as { error: string }).error).toBe(
      "vendo failed to start — see server logs",
    );
    expect(
      error.mock.calls.some((call) =>
        call.some((arg) => arg instanceof Error && arg.message.includes("transient boot blip")),
      ),
    ).toBe(true);

    const second = await handler(req());
    expect(second.status).toBe(200);
    expect(resolveStorage).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
