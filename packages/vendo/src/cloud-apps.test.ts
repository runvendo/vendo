import type { AppDocument } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { cloudApps } from "./cloud-apps.js";

// The umbrella-side share/publish console client (release-gap fix 2026-07-20):
// the implementation the composition seam injects into the apps block's
// CloudAppsClient seam. Behavior comes ONLY from constructor arguments
// (adapter rule); it rides the shared console-client plumbing —
// deployment-identity headers, per-request abort timeout, and the honest
// 401/402 → cloud-required error table (cloud-console.ts).

const doc: AppDocument = {
  format: "vendo/app@1",
  id: "app_cloud",
  name: "Cloud app",
};

const snapshot = {
  id: "share_1",
  doc,
  createdAt: "2026-07-11T12:00:00.000Z",
};

const record = {
  id: "publish_1",
  appId: doc.id,
  version: "1",
  createdAt: "2026-07-11T12:00:00.000Z",
};

describe("cloudApps", () => {
  it("posts the app document bearer-keyed with deployment identity and validates responses", async () => {
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
      return request.url.endsWith("/share") ? Response.json(snapshot) : Response.json(record);
    });
    const client = cloudApps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.share(doc.id, doc)).resolves.toEqual(snapshot);
    await expect(client.publish(doc.id, doc)).resolves.toEqual(record);

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/share",
      method: "POST",
      authorization: "Bearer vnd_secret",
      contentType: "application/json",
      signal: true,
      body: { appId: doc.id, doc },
    });
    expect(requests[1]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/publish",
      method: "POST",
      body: { appId: doc.id, doc },
    });
    for (const sent of requests) {
      expect(sent.deploymentHost).toEqual(expect.any(String));
      expect(sent.deploymentHost).not.toBe("");
    }
  });

  it("defaults the base URL to the Vendo console", async () => {
    const fetchImpl = vi.fn(async () => Response.json(snapshot));
    const client = cloudApps({ apiKey: "vnd_secret", fetch: fetchImpl as unknown as typeof fetch });
    await client.share(doc.id, doc);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://console.vendo.run/api/v1/apps/share");
  });

  it("maps the meter (402) and a bad key (401) to cloud-required with the server's message", async () => {
    for (const [status, message] of [[402, "Upgrade your Vendo Cloud plan"], [401, "invalid API key"]] as const) {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { code: "unauthorized", message } }, { status }));
      const client = cloudApps({
        apiKey: "vnd_key",
        baseUrl: "https://cloud.test",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.share(doc.id, doc)).rejects.toMatchObject({ code: "cloud-required", message });
    }
  });

  it("forwards wire-legal console error codes as VendoErrors", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { code: "conflict", message: "already published" } }, { status: 409 }));
    const client = cloudApps({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.publish(doc.id, doc)).rejects.toMatchObject({
      code: "conflict",
      message: "already published",
    });
  });

  it("a console 5xx does not read as a caller validation error", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const client = cloudApps({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await client.share(doc.id, doc).then(
      () => { throw new Error("expected share to reject"); },
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
    const client = cloudApps({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    // A misdeployed console is the SERVICE misbehaving, never the caller's
    // fault — hosted-store's malformed-200 posture: a plain Error, not a
    // wire-legal "validation" VendoError that would blame the share input.
    const failure = await client.share(doc.id, doc).then(
      () => { throw new Error("expected share to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.message).toMatch(/non-JSON/i);
    expect(failure.code).toBeUndefined();
  });

  it("aborts a hung console request after timeoutMs", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    const client = cloudApps({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    await expect(client.share(doc.id, doc)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
