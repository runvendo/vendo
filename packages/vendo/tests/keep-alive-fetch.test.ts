import { readFileSync } from "node:fs";

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

  // The tsc-only dist ships this dynamic import verbatim, and webpack follows
  // it statically — Next 14's parser cannot read undici 7's syntax, so the
  // whole wire route failed to COMPILE on Next 14 hosts (GitHub #1369). The
  // magic comment tells bundlers to leave the import to the runtime, where the
  // existing catch already covers every no-undici target.
  it("marks the undici import so bundlers never follow it", () => {
    const source = readFileSync(new URL("../src/keep-alive-fetch.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import\(\s*\/\* webpackIgnore: true \*\/\s*"undici"\s*\)/);
  });
});
