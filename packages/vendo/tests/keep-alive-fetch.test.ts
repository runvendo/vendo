import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { keepAliveFetch } from "../src/keep-alive-fetch.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(): { calls: Array<{ input: unknown; init?: RequestInit }> } {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  return { calls };
}

describe("keepAliveFetch", () => {
  it("sends every Cloud request over ONE shared pool", async () => {
    const { calls } = captureFetch();

    await keepAliveFetch("https://console.vendo.run/api/v1/store/status");
    await keepAliveFetch("https://console.vendo.run/api/v1/store/status", { method: "POST" });

    const dispatchers = calls.map(({ init }) => (init as { dispatcher?: unknown } | undefined)?.dispatcher);
    expect(dispatchers[0]).toBeInstanceOf(Agent);
    // The SAME pool both times: a per-call agent would reopen the connection
    // this fix exists to keep, which is the defect the shape has to rule out.
    expect(dispatchers[1]).toBe(dispatchers[0]);
    expect(calls[1]?.init?.method).toBe("POST");
  });
});
