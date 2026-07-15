import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@vendoai/core";
import type { Connector, ConnectorAccount } from "@vendoai/actions";
import { createConnections } from "./connections.js";

const ada: Principal = { kind: "user", subject: "user_ada" };
const anonymous: Principal = { kind: "user", subject: "anonymous_abc", ephemeral: true };

function fakeConnector(name: string, accounts: Record<string, ConnectorAccount[]>): Connector {
  return {
    name,
    descriptors: async () => [],
    execute: async () => ({ status: "ok", output: {} }),
    connections: {
      list: async (subject) => accounts[subject] ?? [],
      initiate: async (subject, toolkit) => ({ id: `ca_${subject}_${toolkit}`, redirectUrl: "https://connect.test/x" }),
      status: async (subject, id) => (accounts[subject] ?? []).find((account) => account.id === id) ?? null,
      disconnect: async (subject, id) => {
        if (!(accounts[subject] ?? []).some((account) => account.id === id)) throw new Error(`not found: ${id}`);
      },
    },
  };
}

const adaGmail: ConnectorAccount = { id: "ca_1", connector: "composio", toolkit: "gmail", status: "active" };

describe("createConnections broker selection", () => {
  it("prefers a BYO connector capability and reports byo posture", () => {
    const service = createConnections({
      connectors: [fakeConnector("composio", {})],
      env: { VENDO_API_KEY: "vnd_key" },
    });
    expect(service.posture).toBe("byo");
  });

  it("rides the cloud broker when only VENDO_API_KEY is set", () => {
    const service = createConnections({ connectors: [], env: { VENDO_API_KEY: "vnd_key" } });
    expect(service.posture).toBe("cloud");
  });

  it("has no posture and fails closed with neither", async () => {
    const service = createConnections({ connectors: [], env: {} });
    expect(service.posture).toBe(false);
    await expect(service.list(ada)).resolves.toEqual([]);
    await expect(service.initiate(ada, { toolkit: "gmail" })).rejects.toThrow(/connected accounts/i);
  });
});

describe("createConnections over BYO connectors", () => {
  const service = () =>
    createConnections({
      connectors: [fakeConnector("composio", { user_ada: [adaGmail] })],
      env: {},
    });

  it("lists, reads, and disconnects per-principal", async () => {
    expect(await service().list(ada)).toEqual([adaGmail]);
    expect(await service().status(ada, "composio", "ca_1")).toEqual(adaGmail);
    expect(await service().status(ada, "composio", "ca_other")).toBeNull();
    await expect(service().disconnect(ada, "composio", "ca_1")).resolves.toBeUndefined();
  });

  it("initiates against the named connector and validates the callback URL", async () => {
    const initiated = await service().initiate(ada, {
      connector: "composio",
      toolkit: "gmail",
      callbackUrl: "https://host.test/vendo",
    });
    expect(initiated).toEqual({ id: "ca_user_ada_gmail", connector: "composio", redirectUrl: "https://connect.test/x" });
    await expect(
      service().initiate(ada, { toolkit: "gmail", callbackUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/callback/i);
  });

  it("refuses to initiate for ephemeral principals", async () => {
    await expect(service().initiate(anonymous, { toolkit: "gmail" })).rejects.toThrow(/sign/i);
  });

  it("refuses to initiate for synthetic webhook subjects", async () => {
    for (const subject of ["webhook:stripe", "vendo:webhook:stripe"]) {
      await expect(
        service().initiate({ kind: "user", subject }, { toolkit: "gmail" }),
      ).rejects.toThrow(/reserved/i);
    }
  });

  it("rejects an unknown connector name", async () => {
    await expect(service().initiate(ada, { connector: "zapier", toolkit: "gmail" })).rejects.toThrow(/connector/i);
  });
});

describe("createConnections over the cloud broker", () => {
  it("sends bearer-keyed per-subject requests to the cloud endpoint", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; body?: unknown }> = [];
    const cloudFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        ...(request.method === "POST" ? { body: await request.json() } : {}),
      });
      if (request.method === "POST") {
        return Response.json({ id: "ca_cloud", connector: "composio", redirectUrl: "https://connect.cloud/x" });
      }
      if (request.method === "DELETE") return Response.json({});
      return Response.json({ connections: [adaGmail] });
    });
    const service = createConnections({
      connectors: [],
      env: { VENDO_API_KEY: "vnd_secret", VENDO_CLOUD_URL: "https://cloud.test" },
      fetch: cloudFetch as unknown as typeof fetch,
    });

    expect(await service.list(ada)).toEqual([adaGmail]);
    const initiated = await service.initiate(ada, { toolkit: "gmail", callbackUrl: "https://host.test/vendo" });
    expect(initiated).toEqual({ id: "ca_cloud", connector: "composio", redirectUrl: "https://connect.cloud/x" });
    await service.disconnect(ada, "composio", "ca_cloud");

    expect(requests[0]).toMatchObject({
      method: "GET",
      authorization: "Bearer vnd_secret",
    });
    expect(requests[0]!.url).toContain("https://cloud.test/v1/connections?subject=user_ada");
    expect(requests[1]).toMatchObject({
      method: "POST",
      authorization: "Bearer vnd_secret",
      body: { subject: "user_ada", toolkit: "gmail", callbackUrl: "https://host.test/vendo" },
    });
    expect(requests[2]).toMatchObject({ method: "DELETE", authorization: "Bearer vnd_secret" });
    expect(requests[2]!.url).toContain("/v1/connections/ca_cloud?subject=user_ada&connector=composio");
  });

  it("maps a cloud entitlement rejection to a cloud-required error", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ error: { code: "cloud-required", message: "plan does not include connections" } }, { status: 402 }));
    const service = createConnections({
      connectors: [],
      env: { VENDO_API_KEY: "vnd_secret", VENDO_CLOUD_URL: "https://cloud.test" },
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await expect(service.initiate(ada, { toolkit: "gmail" })).rejects.toThrow(/plan does not include/i);
  });
});
