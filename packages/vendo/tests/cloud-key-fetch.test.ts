import { describe, expect, it, vi } from "vitest";

import { cloudKeyFetch, resolveCloudBaseUrl } from "../src/cloud-key-fetch.js";

describe("resolveCloudBaseUrl", () => {
  it("prefers explicit apiUrl, then env, then the console default, trimming slashes", () => {
    expect(resolveCloudBaseUrl({ apiUrl: "https://x.test//" })).toBe("https://x.test");
    expect(resolveCloudBaseUrl({ env: { VENDO_CLOUD_URL: "https://env.test/" } })).toBe("https://env.test");
    expect(resolveCloudBaseUrl({ env: {} })).toBe("https://console.vendo.run");
  });

  it("works without a process global (Workers)", () => {
    expect(resolveCloudBaseUrl({ env: {} })).toBe("https://console.vendo.run");
  });
});

describe("cloudKeyFetch", () => {
  it("POSTs JSON with bearer key auth and parses the JSON response", async () => {
    let seen: { url: string; method?: string; headers: Record<string, string>; body?: string } | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      seen = {
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      };
      return Promise.resolve(new Response(JSON.stringify({ accepted: 1 }), {
        headers: { "content-type": "application/json" },
      }));
    };
    const result = await cloudKeyFetch<{ accepted: number }>("/api/v1/misses", {
      apiKey: "vnd_test",
      env: { VENDO_CLOUD_URL: "https://console.test" },
      fetchImpl,
      body: { events: [] },
    });
    expect(result).toEqual({ accepted: 1 });
    expect(seen?.url).toBe("https://console.test/api/v1/misses");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.authorization).toBe("Bearer vnd_test");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.body).toBe(JSON.stringify({ events: [] }));
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response("no", { status: 402 }));
    await expect(cloudKeyFetch("/api/v1/misses", { apiKey: "vnd_test", env: {}, fetchImpl, body: {} }))
      .rejects.toThrow(/402/);
  });

  it("refuses an empty key instead of falling back to VENDO_API_KEY (adapter rule: the seam passes the key)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(cloudKeyFetch("/api/v1/misses", {
      apiKey: "",
      env: { VENDO_API_KEY: "vnd_env_fallback" },
      fetchImpl,
      body: {},
    })).rejects.toThrow(/without a key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the module free of node builtins, CLI imports, and any VENDO_API_KEY read", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/cloud-key-fetch.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
    expect(source).not.toMatch(/\.\/cli\//);
    expect(source).not.toMatch(/process\.env[^?]/);
    expect(source).not.toMatch(/VENDO_API_KEY/);
  });
});
