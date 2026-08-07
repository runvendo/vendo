import type { RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { servedProxyRoutes } from "./box.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "./shared.js";

/** Build contract §9.8 — the served-app proxy is the ONLY door to an org app's
    surface, so whatever the browser asked for has to survive the crossing:
    method, path, QUERY STRING, content-type and body, and nothing else. */

interface Seen {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

const wireFor = (url: string, method = "GET", seen: Seen[] = []): {
  wire: WireContext;
  seen: Seen[];
} => {
  const parsed = new URL(url);
  const path = parsed.pathname.slice("/api/vendo".length);
  const request = new Request(url, {
    method,
    ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
  });
  const deps = {
    apps: {
      async serve(_appId: string, boxRequest: Seen) {
        seen.push(boxRequest);
        return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array() };
      },
    },
  } as unknown as WireDeps;
  return {
    seen,
    wire: {
      request,
      url: parsed,
      path,
      segments: routeSegments(path),
      params: {},
      context: async (): Promise<RunContext> => ({
        principal: { kind: "user", subject: "kim" },
        venue: "app",
        presence: "present",
        sessionId: "s_kim",
      }),
      deps,
    },
  };
};

describe("§9.8 — the served proxy forwards the whole request line", () => {
  it("carries the QUERY STRING into the box, not just the path", async () => {
    // A parameterized request must arrive parameterized: dropping the query
    // breaks every served app that reads one (?tab=, ?vendoTheme=, pagination).
    const { wire, seen } = wireFor("https://maple.test/api/vendo/apps/app_1/serve/orders?tab=open&page=2");
    const answer = await dispatchRoutes(servedProxyRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/orders?tab=open&page=2");
  });

  it("forwards a bare path unchanged, with no stray question mark", async () => {
    const { wire, seen } = wireFor("https://maple.test/api/vendo/apps/app_1/serve/");
    await dispatchRoutes(servedProxyRoutes, wire);
    expect(seen[0]?.path).toBe("/");
  });

  it("still forwards the PAYLOAD only — no cookie, authorization or host header", async () => {
    const { wire, seen } = wireFor("https://maple.test/api/vendo/apps/app_1/serve/save?id=7", "POST");
    await dispatchRoutes(servedProxyRoutes, wire);
    expect(seen[0]?.path).toBe("/save?id=7");
    expect(Object.keys(seen[0]?.headers ?? {})).toEqual(["content-type"]);
  });
});
