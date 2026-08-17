import { describe, expect, it } from "vitest";
import { consoleSender, raiseCloudError } from "../src/cloud-console.js";
import { deploymentIdentityHeaders } from "../src/deployment-identity.js";
import { VendoError } from "../src/errors.js";

// Stand-in for an adapter's own tail: whatever the raise could not read reaches here.
const tail = (code: string | undefined, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const enveloped = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const raised = (promise: Promise<never>): Promise<unknown> =>
  promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);

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
      raiseCloudError(enveloped(400, { error: { code: "weird-code", message: "Sandbox pool is drained." } }), "sandbox", tail),
    ).rejects.toMatchObject({ code: "weird-code", message: "Sandbox pool is drained." });
  });

  it("falls back to a service-and-status sentence with no code when the body is not JSON", async () => {
    await expect(
      raiseCloudError(new Response("<html>nginx</html>", { status: 400 }), "store", tail),
    ).rejects.toMatchObject({ code: undefined, message: "Vendo Cloud store request failed with 400" });
  });

  it("uses the same fallback sentence when the envelope carries no message", async () => {
    await expect(
      raiseCloudError(enveloped(400, { error: { code: "boom" } }), "apps", tail),
    ).rejects.toMatchObject({ code: "boom", message: "Vendo Cloud apps request failed with 400" });
  });

  it("forwards the console's own unavailable and forbidden as real VendoErrors", async () => {
    for (const [code, status] of [["unavailable", 503], ["forbidden", 403]] as const) {
      const error = await raised(
        raiseCloudError(enveloped(status, { error: { code, message: "Storage is offline." } }), "store", tail),
      );
      expect(error, code).toBeInstanceOf(VendoError);
      expect(error).toMatchObject({ code, message: "Storage is offline." });
    }
  });

  it("reads a rate limit as unavailable — enveloped, or bare from an edge proxy", async () => {
    // The console's own 429 envelope: its sentence is the one the person reads.
    const enveloped429 = await raised(raiseCloudError(
      enveloped(429, { error: { code: "rate-limited", message: "Too many requests. Try again shortly." } }),
      "store",
      tail,
    ));
    expect(enveloped429).toBeInstanceOf(VendoError);
    expect(enveloped429).toMatchObject({ code: "unavailable", message: "Too many requests. Try again shortly." });

    // The edge proxy's plain-text 429 never reaches the console's envelope, and
    // an upstream 5xx is the same transient story.
    for (const status of [429, 500, 502, 503, 504]) {
      const error = await raised(raiseCloudError(new Response("Too Many Requests", { status }), "store", tail));
      expect(error, String(status)).toBeInstanceOf(VendoError);
      expect(error).toMatchObject({ code: "unavailable", message: `Vendo Cloud store request failed with ${status}` });
    }
    // 501 is not transient — it is "this mount does not serve the op", which
    // each adapter's own tail says better.
    expect(await raised(raiseCloudError(new Response("nope", { status: 501 }), "store", tail)))
      .not.toBeInstanceOf(VendoError);
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
