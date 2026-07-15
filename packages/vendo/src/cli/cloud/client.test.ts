import { describe, expect, it, vi } from "vitest";
import { CloudError, cloudFetch, resolveCloudBaseUrl } from "./client.js";
import { CLI_VERSION } from "../shared.js";

describe("cloud client", () => {
  it("resolves the explicit URL before the environment and default", () => {
    expect(resolveCloudBaseUrl({
      apiUrl: "https://example.test/root/",
      env: { VENDO_CLOUD_URL: "https://ignored.test" },
    })).toBe("https://example.test/root");
    expect(resolveCloudBaseUrl({ env: { VENDO_CLOUD_URL: "https://env.test/" } })).toBe("https://env.test");
    expect(resolveCloudBaseUrl({ env: {} })).toBe("https://console.vendo.run");
  });

  it("turns API error envelopes into CloudError instances", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      error: { code: "cloud-required", message: "Upgrade required" },
    }, { status: 402 }));

    await expect(cloudFetch("/api/v1/keys/validate", {
      auth: "key",
      apiKey: "vnd_test",
      fetchImpl,
    })).rejects.toMatchObject<Partial<CloudError>>({
      name: "CloudError",
      code: "cloud-required",
      message: "Upgrade required",
      status: 402,
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ "user-agent": `vendo-cli/${CLI_VERSION}` }),
    }));
  });

  it("refreshes a user session once after a 401 and retries the request", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "unauthorized", message: "Expired" } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "fresh", refresh_token: "next", expires_at: 2_000_000_000 }))
      .mockResolvedValueOnce(Response.json([{ id: "org_1" }]));
    const writeSession = vi.fn();

    await expect(cloudFetch("/api/v1/orgs", {
      auth: "user",
      fetchImpl,
      sessionStore: {
        read: async () => ({ access_token: "old", refresh_token: "refresh", expires_at: 2_000_000_000 }),
        write: writeSession,
      },
    })).resolves.toEqual([{ id: "org_1" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({ headers: expect.objectContaining({ "user-agent": `vendo-cli/${CLI_VERSION}` }) });
    }
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer fresh" }) });
    expect(writeSession).toHaveBeenCalledWith({ access_token: "fresh", refresh_token: "next", expires_at: 2_000_000_000 });
  });
});
