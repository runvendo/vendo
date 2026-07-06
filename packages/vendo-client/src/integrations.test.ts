import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerIntegrations } from "./integrations.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createServerIntegrations.disconnect", () => {
  it("throws and does not mark the row disconnected when the server rejects", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const integrations = createServerIntegrations("/api/vendo");
    await expect(integrations.disconnect("gmail")).rejects.toThrow();
  });

  it("updates the cache and returns disconnected on an ok response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ integrations: [{ id: "gmail", name: "Gmail", connected: false }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const integrations = createServerIntegrations("/api/vendo");
    const result = await integrations.disconnect("gmail");
    expect(result).toEqual({ id: "gmail", name: "Gmail", connected: false });
  });
});
