import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@vendoai/core";
import type { Connector, ConnectorAccount } from "@vendoai/actions";
import { byoConnections, cloudConnections, unconfiguredConnections } from "./connections.js";

const ada: Principal = { kind: "user", subject: "user_ada" };
const anonymous: Principal = { kind: "user", subject: "anonymous_abc", ephemeral: true };

function fakeConnector(
  name: string,
  accounts: Record<string, ConnectorAccount[]>,
  connectable?: string[],
): Connector {
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
      ...(connectable === undefined
        ? {}
        : { listConnectable: async () => connectable.map((toolkit) => ({ toolkit })) }),
    },
  };
}

const adaGmail: ConnectorAccount = { id: "ca_1", connector: "composio", toolkit: "gmail", status: "active" };

describe("byoConnections", () => {
  const service = () => byoConnections([fakeConnector("composio", { user_ada: [adaGmail] })]);

  it("reports byo posture", () => {
    expect(service().posture).toBe("byo");
  });

  it("refuses connectors with no connections capability", () => {
    const bare: Connector = { name: "bare", descriptors: async () => [], execute: async () => ({ status: "ok", output: {} }) };
    expect(() => byoConnections([bare])).toThrow(/connections/i);
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

  it("aggregates the catalog across brokers, tagging each row with its connector", async () => {
    const catalog = await byoConnections([
      fakeConnector("composio", {}, ["gmail", "slack"]),
      fakeConnector("other", {}, ["jira"]),
    ]).catalog();
    expect(catalog).toEqual([
      { toolkit: "gmail", connector: "composio" },
      { toolkit: "slack", connector: "composio" },
      { toolkit: "jira", connector: "other" },
    ]);
  });

  it("treats a broker without listConnectable as advertising nothing", async () => {
    await expect(service().catalog()).resolves.toEqual([]);
  });
});

describe("cloudConnections", () => {
  it("sends bearer-keyed per-subject requests to the cloud endpoint", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      deploymentHost: string | null;
      deploymentName: string | null;
      body?: unknown;
    }> = [];
    const cloudFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        deploymentHost: request.headers.get("x-vendo-deployment-host"),
        deploymentName: request.headers.get("x-vendo-deployment-name"),
        ...(request.method === "POST" ? { body: await request.json() } : {}),
      });
      if (request.method === "POST") {
        return Response.json({ id: "ca_cloud", connector: "composio", redirectUrl: "https://connect.cloud/x" });
      }
      if (request.method === "DELETE") return Response.json({});
      return Response.json({ connections: [adaGmail] });
    });
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    expect(service.posture).toBe("cloud");

    expect(await service.list(ada)).toEqual([adaGmail]);
    const initiated = await service.initiate(ada, { toolkit: "gmail", callbackUrl: "https://host.test/vendo" });
    expect(initiated).toEqual({ id: "ca_cloud", connector: "composio", redirectUrl: "https://connect.cloud/x" });
    await service.disconnect(ada, "composio", "ca_cloud");

    expect(requests[0]).toMatchObject({
      method: "GET",
      authorization: "Bearer vnd_secret",
    });
    expect(requests[0]!.url).toContain("https://cloud.test/api/v1/connections?subject=user_ada");
    expect(requests[1]).toMatchObject({
      method: "POST",
      authorization: "Bearer vnd_secret",
      body: { subject: "user_ada", toolkit: "gmail", callbackUrl: "https://host.test/vendo" },
    });
    expect(requests[2]).toMatchObject({ method: "DELETE", authorization: "Bearer vnd_secret" });
    expect(requests[2]!.url).toContain("/api/v1/connections/ca_cloud?subject=user_ada&connector=composio");
    // Interaction model: every key-authed request carries the deployment
    // identity the console meters usage from.
    for (const sent of requests) {
      expect(sent.deploymentHost).toEqual(expect.any(String));
      expect(sent.deploymentHost).not.toBe("");
      expect(sent.deploymentName).toEqual(expect.any(String));
      expect(sent.deploymentName).not.toBe("");
    }
  });

  it("defaults the base URL to the Vendo console", async () => {
    const cloudFetch = vi.fn(async () => Response.json({ connections: [] }));
    const service = cloudConnections({ apiKey: "vnd_secret", fetch: cloudFetch as unknown as typeof fetch });
    await service.list(ada);
    expect(cloudFetch.mock.calls[0]![0]).toContain("https://console.vendo.run/api/v1/connections");
  });

  it("fails loudly when a misdeployed Cloud base answers 2xx with non-JSON instead of masking it as empty", async () => {
    // An SPA host or reverse proxy that 200s unknown paths with text/html
    // must surface as a config error — not render the honest-looking empty
    // connections state forever, or read a known-connected account as
    // not-found (hosted-store's malformed-200 posture).
    const cloudFetch = vi.fn(async () => new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await expect(service.list(ada)).rejects.toThrow(/non-JSON/i);
    await expect(service.status(ada, "composio", "ca_1")).rejects.toThrow(/non-JSON/i);
  });

  it("rejects a 2xx JSON body without the connections envelope instead of listing empty", async () => {
    const cloudFetch = vi.fn(async () => Response.json({ ok: true }));
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await expect(service.list(ada)).rejects.toThrow(/connections array/i);
  });

  it("maps a cloud plan rejection to a cloud-required error", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ error: { code: "cloud-required", message: "plan does not include connections" } }, { status: 402 }));
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await expect(service.initiate(ada, { toolkit: "gmail" })).rejects.toThrow(/plan does not include/i);
  });

  // Release-gap fixes (2026-07-20): the connections client joins the shared
  // console-client posture (cloud-console.ts) — per-request abort timeout and
  // the honest 401/402 → cloud-required error table.
  it("maps an invalid or revoked key (401) to cloud-required, never caller validation", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ error: { code: "unauthorized", message: "invalid API key" } }, { status: 401 }));
    const service = cloudConnections({
      apiKey: "vnd_revoked",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await expect(service.list(ada)).rejects.toMatchObject({
      code: "cloud-required",
      message: "invalid API key",
    });
  });

  it("a console 5xx does not read as a caller validation error", async () => {
    const cloudFetch = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    const failure = await service.list(ada).then(
      () => { throw new Error("expected list to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.code).not.toBe("validation");
    expect(failure.message).toMatch(/502/);
  });

  it("forwards wire-legal console error codes as VendoErrors", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ error: { code: "not-found", message: "no such connection" } }, { status: 404 }));
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await expect(service.status(ada, "composio", "ca_missing")).rejects.toMatchObject({
      code: "not-found",
      message: "no such connection",
    });
  });

  it("aborts a hung console request after timeoutMs instead of wedging the connections surface", async () => {
    const cloudFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
      timeoutMs: 25,
    });
    await expect(service.list(ada)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("sends an abort signal with every request (the default timeout)", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const cloudFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return Response.json({ connections: [] });
    });
    const service = cloudConnections({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: cloudFetch as unknown as typeof fetch,
    });
    await service.list(ada);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("unconfiguredConnections", () => {
  it("has no posture and fails closed", async () => {
    const service = unconfiguredConnections();
    expect(service.posture).toBe(false);
    await expect(service.list(ada)).resolves.toEqual([]);
    await expect(service.initiate(ada, { toolkit: "gmail" })).rejects.toThrow(/connected accounts/i);
  });
});

describe("catalog posture", () => {
  it("cloud rides the console's catalog endpoint", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ available: [{ toolkit: "gmail", connector: "composio" }] }));
    const cloud = cloudConnections({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: cloudFetch as unknown as typeof fetch });
    await expect(cloud.catalog()).resolves.toEqual([{ toolkit: "gmail", connector: "composio" }]);
    expect(String(cloudFetch.mock.calls[0]![0])).toBe("https://cloud.test/api/v1/connections/catalog");
  });

  it("unconfigured advertises nothing", async () => {
    await expect(unconfiguredConnections().catalog()).resolves.toEqual([]);
  });
});

describe("adapter rule", () => {
  // Env prefixes an adapter could be tempted to sniff. Lanes cloning this test
  // for their block must widen the list to that block's vars (e.g. E2B_ /
  // MODAL_ for sandbox, model-key vars for inference).
  const WATCHED_ENV_PREFIXES = ["VENDO_"];

  it("no adapter reads the environment: behavior comes only from constructor arguments", async () => {
    // The adapter rule bans hidden key-conditional branches: prove it by
    // recording every process.env read while all three adapters construct and
    // serve calls, with tempting VENDO_* values present.
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy({ ...realEnv, VENDO_API_KEY: "vnd_env", VENDO_CLOUD_URL: "https://env.test" }, {
      get(target, property) {
        if (typeof property === "string") reads.push(property);
        return target[property as keyof typeof target];
      },
    });
    try {
      const byo = byoConnections([fakeConnector("composio", { user_ada: [adaGmail] })]);
      expect(await byo.list(ada)).toEqual([adaGmail]);

      const cloudFetch = vi.fn(async () => Response.json({ connections: [] }));
      const cloud = cloudConnections({ apiKey: "vnd_arg", baseUrl: "https://arg.test", fetch: cloudFetch as unknown as typeof fetch });
      await cloud.list(ada);
      expect(cloudFetch.mock.calls[0]![0]).toContain("https://arg.test/");

      const dark = unconfiguredConnections();
      await expect(dark.initiate(ada, { toolkit: "gmail" })).rejects.toThrow(/connected accounts/i);

      expect(reads.filter((key) => WATCHED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    } finally {
      process.env = realEnv;
    }
  });
});
