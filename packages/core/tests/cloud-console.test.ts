import { describe, expect, it } from "vitest";
import { consoleSender, raiseCloudError } from "../src/cloud-console.js";
import { deploymentIdentityHeaders } from "../src/deployment-identity.js";

// Stand-in for an adapter's own tail: whatever the raise could not read reaches here.
const tail = (code: string | undefined, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const enveloped = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("raiseCloudError", () => {
  it("forwards a wire-legal console code as a VendoError carrying the server's message", async () => {
    await expect(
      raiseCloudError(enveloped(409, { error: { code: "conflict", message: "Slug already taken." } }), "store", tail),
    ).rejects.toMatchObject({ code: "conflict", message: "Slug already taken." });
  });

  it("reads both standing refusals (401, 402) as cloud-required", async () => {
    for (const status of [401, 402]) {
      await expect(
        raiseCloudError(
          enveloped(status, { error: { code: "unauthorized", message: "Valid API key required." } }),
          "store",
          tail,
        ),
        String(status),
      ).rejects.toMatchObject({ code: "cloud-required", message: "Valid API key required." });
    }
  });

  it("hands a code it does not know to the adapter's own tail", async () => {
    await expect(
      raiseCloudError(enveloped(503, { error: { code: "unavailable", message: "Sandbox pool is drained." } }), "sandbox", tail),
    ).rejects.toMatchObject({ code: "unavailable", message: "Sandbox pool is drained." });
  });

  it("falls back to a service-and-status sentence with no code when the body is not JSON", async () => {
    await expect(
      raiseCloudError(new Response("<html>nginx</html>", { status: 502 }), "store", tail),
    ).rejects.toMatchObject({ code: undefined, message: "Vendo Cloud store request failed with 502" });
  });

  it("uses the same fallback sentence when the envelope carries no message", async () => {
    await expect(
      raiseCloudError(enveloped(500, { error: { code: "boom" } }), "apps", tail),
    ).rejects.toMatchObject({ code: "boom", message: "Vendo Cloud apps request failed with 500" });
  });
});

describe("consoleSender", () => {
  const send = (fetchImpl: typeof fetch, raise: (response: Response) => Promise<never>) =>
    consoleSender({
      base: "https://console.vendo.run",
      mountPath: "/api/store",
      apiKey: "vk_live_1",
      timeoutMs: 5_000,
      fetchImpl,
      raise,
    });

  const ok = (): { calls: [string, RequestInit][]; fetchImpl: typeof fetch; response: Response } => {
    const calls: [string, RequestInit][] = [];
    const response = new Response("{}", { status: 200 });
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(response);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl, response };
  };

  const raises = async (): Promise<never> => {
    throw new Error("unreachable");
  };

  it("calls base + mountPath + path with bearer auth, a JSON accept and the deployment identity", async () => {
    const { calls, fetchImpl } = ok();
    await send(fetchImpl, raises)("/collections");
    expect(calls[0]![0]).toBe("https://console.vendo.run/api/store/collections");
    expect(calls[0]![1].headers).toEqual({
      authorization: "Bearer vk_live_1",
      accept: "application/json",
      ...(await deploymentIdentityHeaders()),
    });
  });

  it("merges the caller's own headers in, and lets them win where they overlap", async () => {
    const { calls, fetchImpl } = ok();
    await send(fetchImpl, raises)("/collections", { method: "POST", headers: { accept: "text/plain", "x-trace": "t1" } });
    expect(calls[0]![1]).toMatchObject({ method: "POST" });
    expect(calls[0]![1].headers).toMatchObject({ accept: "text/plain", "x-trace": "t1" });
  });

  it("hands a 2xx back untouched and puts anything else through the adapter's raise", async () => {
    const { fetchImpl, response } = ok();
    expect(await send(fetchImpl, raises)("/collections")).toBe(response);

    const refused = new Response("{}", { status: 409 });
    const seen: Response[] = [];
    const refusing = (() => Promise.resolve(refused)) as unknown as typeof fetch;
    await expect(
      send(refusing, async (r) => {
        seen.push(r);
        throw new Error("raised");
      })("/collections"),
    ).rejects.toThrow("raised");
    expect(seen).toEqual([refused]);
  });
});
