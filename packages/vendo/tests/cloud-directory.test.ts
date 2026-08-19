import type { Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { cloudDirectory } from "../src/cloud-directory.js";

const bob: Principal = { kind: "user", subject: "u_bob" };
const kim: Principal = { kind: "user", subject: "u_kim" };

const payload = {
  memberships: [{ org: "acme", display: "Acme Corp" }],
  limits: { acme: { generationsPerMonth: { limit: 1000, scope: "per-tenant" } } },
};

/** A fetch that answers `answers` in order and records every URL it saw. */
const fetchOf = (...answers: Response[]) => {
  const urls: string[] = [];
  let next = 0;
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return answers[Math.min(next++, answers.length - 1)]!.clone();
  }) as typeof fetch;
  return { impl, urls };
};

const ok = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("cloudDirectory", () => {
  it("asks the console once per subject inside the TTL", async () => {
    const { impl, urls } = fetchOf(ok(payload));
    const directory = cloudDirectory({ apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl });

    await expect(directory.memberships(bob)).resolves.toEqual(payload.memberships);
    await expect(directory.memberships(bob)).resolves.toEqual(payload.memberships);
    expect(urls).toEqual(["https://console.test/api/v1/users/u_bob/memberships"]);
  });

  it("keeps one entry per subject", async () => {
    const { impl, urls } = fetchOf(ok(payload));
    const directory = cloudDirectory({ apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl });
    await directory.entry(bob);
    await directory.entry(kim);
    expect(urls).toHaveLength(2);
  });

  it("re-asks once the TTL has passed", async () => {
    const { impl, urls } = fetchOf(ok(payload));
    const directory = cloudDirectory({
      apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl, ttlMs: 0,
    });
    await directory.entry(bob);
    await directory.entry(bob);
    expect(urls).toHaveLength(2);
  });

  // A directory outage must not take the host's product down: `memberships` is
  // awaited inside per-request context resolution, so a throw is a 500 for the
  // whole turn.
  it("degrades a 404 to no memberships, and does not throw", async () => {
    const { impl } = fetchOf(new Response("", { status: 404 }));
    const directory = cloudDirectory({ apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl });
    await expect(directory.entry(bob)).resolves.toEqual({ memberships: [], limits: {} });
  });

  it("serves the stale entry when the console goes down", async () => {
    const { impl } = fetchOf(ok(payload), new Response("", { status: 503 }));
    const directory = cloudDirectory({
      apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl, ttlMs: 0,
    });
    await directory.entry(bob);
    await expect(directory.entry(bob)).resolves.toEqual(payload);
  });

  it("degrades a malformed 200 rather than throwing at the caller", async () => {
    const { impl } = fetchOf(ok({ memberships: "nope" }));
    const directory = cloudDirectory({ apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl });
    await expect(directory.memberships(bob)).resolves.toEqual([]);
  });

  it("sends the key as a bearer token", async () => {
    const seen: Record<string, string>[] = [];
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return ok(payload);
    }) as typeof fetch;
    const directory = cloudDirectory({ apiKey: "vk_test", baseUrl: "https://console.test", fetch: impl });
    await directory.entry(bob);
    expect(seen[0]?.["authorization"]).toBe("Bearer vk_test");
  });
});

describe("the server surface", () => {
  // The console's seam test drives the REAL consumer — no stub on either side —
  // so these three are public surface, not an implementation detail.
  it("exports the directory, its policy, and the limiter", async () => {
    const server = await import("../src/server.js");
    expect(typeof server.cloudDirectory).toBe("function");
    expect(typeof server.tenantLimits).toBe("function");
    expect(typeof server.createLimiter).toBe("function");
  });
});
