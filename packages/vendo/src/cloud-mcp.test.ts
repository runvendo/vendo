import { describe, expect, it, vi } from "vitest";
import { cloudMcpTenant } from "./cloud-mcp.js";

// The umbrella-side broker ensure-tenant console client (MCP broker
// provisioning plan 2026-08-03, task B1): the implementation selectMcpBroker
// injects when VENDO_API_KEY + a public VENDO_BASE_URL fill the mcp seam.
// Behavior comes ONLY from constructor arguments (adapter rule); it rides the
// shared console-client plumbing — deployment-identity headers, per-request
// abort timeout, and the honest 401/402 → cloud-required error table
// (cloud-console.ts). The mocked responses below are byte-precise to the
// FROZEN WIRE CONTRACT in the plan; Worker A builds the server side against
// the same bytes.

const ensureResponse = {
  tenant: {
    slug: "maple",
    issuer: "https://maple.mcp.vendo.run",
    audience: "https://maple.mcp.vendo.run/mcp",
    status: "active",
    upstreamOrigin: "https://app.maplebank.com",
    upstreamMount: "/api/vendo/mcp",
  },
  federationSecret: "c2VjcmV0LWJhc2U2NHVybA",
};

describe("cloudMcpTenant", () => {
  it("posts { baseUrl, mount } bearer-keyed with deployment identity and returns the parsed ensure response", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      contentType: string | null;
      deploymentHost: string | null;
      signal: boolean;
      body: unknown;
    }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        deploymentHost: request.headers.get("x-vendo-deployment-host"),
        signal: init?.signal instanceof AbortSignal,
        body: await request.json(),
      });
      return Response.json(ensureResponse);
    });
    const client = cloudMcpTenant({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.ensure({
      baseUrl: "https://app.maplebank.com",
      mount: "/api/vendo/mcp",
    })).resolves.toEqual(ensureResponse);

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/mcp/tenant",
      method: "POST",
      authorization: "Bearer vnd_secret",
      contentType: "application/json",
      signal: true,
      body: { baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" },
    });
    expect(requests[0]!.deploymentHost).toEqual(expect.any(String));
    expect(requests[0]!.deploymentHost).not.toBe("");
  });

  it("defaults the base URL to the Vendo console", async () => {
    const fetchImpl = vi.fn(async () => Response.json(ensureResponse));
    const client = cloudMcpTenant({ apiKey: "vnd_secret", fetch: fetchImpl as unknown as typeof fetch });
    await client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://console.vendo.run/api/v1/mcp/tenant");
  });

  it("still returns the secret for a disabled tenant (broker refuses traffic; the host keeps composing)", async () => {
    const disabled = {
      ...ensureResponse,
      tenant: { ...ensureResponse.tenant, status: "disabled" },
    };
    const fetchImpl = vi.fn(async () => Response.json(disabled));
    const client = cloudMcpTenant({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" }))
      .resolves.toEqual(disabled);
  });

  it("maps the meter (402) and a bad key (401) to cloud-required with the server's message", async () => {
    for (const [status, message] of [[402, "Upgrade your Vendo Cloud plan"], [401, "invalid API key"]] as const) {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { code: "unauthorized", message } }, { status }));
      const client = cloudMcpTenant({
        apiKey: "vnd_key",
        baseUrl: "https://cloud.test",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" }))
        .rejects.toMatchObject({ code: "cloud-required", message });
    }
  });

  it("forwards wire-legal console error codes as VendoErrors (the 400 validation envelope)", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { code: "validation", message: "baseUrl must be https://" } }, { status: 400 }));
    const client = cloudMcpTenant({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" }))
      .rejects.toMatchObject({ code: "validation", message: "baseUrl must be https://" });
  });

  it("a console 5xx does not read as a caller validation error", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const client = cloudMcpTenant({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" }).then(
      () => { throw new Error("expected ensure to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.code).not.toBe("validation");
    expect(failure.message).toMatch(/502/);
  });

  it("maps a malformed 2xx body to not-implemented (the knowledge-client posture: a server-shaped failure)", async () => {
    for (const body of [
      () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => Response.json({ tenant: { slug: "maple" } }),
    ]) {
      const fetchImpl = vi.fn(async () => body());
      const client = cloudMcpTenant({
        apiKey: "vnd_key",
        baseUrl: "https://cloud.test",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" }))
        .rejects.toMatchObject({ code: "not-implemented" });
    }
  });

  it("aborts a hung console request after timeoutMs", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    const client = cloudMcpTenant({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    await expect(client.ensure({ baseUrl: "https://app.maplebank.com", mount: "/api/vendo/mcp" }))
      .rejects.toMatchObject({ name: "TimeoutError" });
  });
});
