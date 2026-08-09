import { describe, expect, it, vi } from "vitest";
import { chainSecrets, cloudSecrets } from "../src/cloud-secrets.js";

// The umbrella-side Cloud secrets provider (cloud-supported-everything Lane 6a):
// the implementation the composition seam (selectSecrets in server.ts) chains
// behind envSecrets when VENDO_API_KEY fills the unset slot. Behavior comes
// ONLY from constructor arguments (adapter rule); it rides the shared
// console-client plumbing — deployment-identity headers, per-request abort
// timeout, and the honest 401/402 → cloud-required error table
// (cloud-console.ts). The console endpoint is built in a sibling lane; these
// fixtures ARE the wire contract.

describe("cloudSecrets", () => {
  it("GETs the encoded secret name bearer-keyed with deployment identity and returns the value", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      deploymentHost: string | null;
      signal: boolean;
    }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        deploymentHost: request.headers.get("x-vendo-deployment-host"),
        signal: init?.signal instanceof AbortSignal,
      });
      return Response.json({ value: "s3cret-value" });
    });
    const provider = cloudSecrets({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.get("STRIPE_KEY/odd name")).resolves.toBe("s3cret-value");

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/secrets/STRIPE_KEY%2Fodd%20name",
      method: "GET",
      authorization: "Bearer vnd_secret",
      signal: true,
    });
    expect(requests[0]?.deploymentHost).toEqual(expect.any(String));
    expect(requests[0]?.deploymentHost).not.toBe("");
  });

  it("defaults the base URL to the Vendo console", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ value: "v" }));
    const provider = cloudSecrets({ apiKey: "vnd_secret", fetch: fetchImpl });
    await provider.get("NAME");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://console.vendo.run/api/v1/secrets/NAME");
  });

  it("resolves undefined on 404 — a missing secret is the provider contract's 'unset', not an error", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { code: "not-found", message: "no such secret" } }, { status: 404 }));
    const provider = cloudSecrets({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.get("MISSING")).resolves.toBeUndefined();
  });

  it("maps the meter (402) and a bad key (401) to cloud-required with the server's message", async () => {
    for (const [status, message] of [[402, "Upgrade your Vendo Cloud plan"], [401, "invalid API key"]] as const) {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { code: "unauthorized", message } }, { status }));
      const provider = cloudSecrets({
        apiKey: "vnd_key",
        baseUrl: "https://cloud.test",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      await expect(provider.get("NAME")).rejects.toMatchObject({ code: "cloud-required", message });
    }
  });

  it("a console 5xx does not read as a caller validation error", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const provider = cloudSecrets({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await provider.get("NAME").then(
      () => { throw new Error("expected get to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.code).not.toBe("validation");
    expect(failure.message).toMatch(/502/);
  });

  it("fails loudly on a 2xx that isn't JSON instead of masking a misdeployed base", async () => {
    const fetchImpl = vi.fn(async () => new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    const provider = cloudSecrets({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await provider.get("NAME").then(
      () => { throw new Error("expected get to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.message).toMatch(/non-JSON/i);
    expect(failure.code).toBeUndefined();
  });

  it("fails loudly on a 200 without a string value — never a silent undefined that reads as 'unset'", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ value: 42 }));
    const provider = cloudSecrets({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.get("NAME")).rejects.toThrow(/invalid/i);
  });

  it("aborts a hung console request after timeoutMs", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    const provider = cloudSecrets({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    await expect(provider.get("NAME")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("chainSecrets", () => {
  const constant = (value: string | undefined) => ({ get: async () => value });

  it("returns the first defined, non-empty value without consulting later providers", async () => {
    const later = { get: vi.fn(async () => "shadowed") };
    const chained = chainSecrets(constant("first"), later);
    await expect(chained.get("NAME")).resolves.toBe("first");
    expect(later.get).not.toHaveBeenCalled();
  });

  it("falls through undefined AND empty values to the next provider", async () => {
    const chained = chainSecrets(constant(undefined), constant(""), constant("from-cloud"));
    await expect(chained.get("NAME")).resolves.toBe("from-cloud");
  });

  it("resolves undefined when every provider misses", async () => {
    const chained = chainSecrets(constant(undefined), constant(""));
    await expect(chained.get("NAME")).resolves.toBeUndefined();
  });

  it("propagates a provider failure instead of swallowing it", async () => {
    const chained = chainSecrets(constant(undefined), {
      get: async () => { throw new Error("console unreachable"); },
    });
    await expect(chained.get("NAME")).rejects.toThrow("console unreachable");
  });

  it("passes the requested name through to every consulted provider", async () => {
    const first = { get: vi.fn(async () => undefined) };
    const second = { get: vi.fn(async () => "v") };
    await chainSecrets(first, second).get("STRIPE_KEY");
    expect(first.get).toHaveBeenCalledWith("STRIPE_KEY");
    expect(second.get).toHaveBeenCalledWith("STRIPE_KEY");
  });
});
