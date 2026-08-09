import { describe, expect, it, vi } from "vitest";
import { cloudConfig } from "./cloud-config.js";

// The umbrella-side hosted-config client (cse lane 3). Fetches the PUBLISHED
// config doc from the console's data-plane GET /api/v1/config and exposes it to
// the composition seam (selectConfigSurface). Behavior comes ONLY from
// constructor arguments (adapter rule); it rides the shared console posture —
// Bearer key + deployment-identity headers + per-request abort timeout — but
// carries its OWN sender because the config service's ETag/304 revalidation
// needs the 304 response back (consoleSender raises on every non-2xx).
//
// The wire shapes below are mirrored byte-for-byte from the cross-repo contract
// fixtures at apps/console/fixtures/config-wire/ (get-config.published.*,
// get-config.never-published.*, get-config.not-modified.*).

const RELEASE_ID = "9c5e63c2-0d5f-4f6e-8c33-2b8f4a1d7e91";
const ETAG = `"${RELEASE_ID}"`;
const PUBLISHED_CONFIG = {
  "design-rules.md": "# Design rules\n\nUse the violet brand tokens; never invent new hues.",
  "brief.md": "Maple is a retail bank; the agent acts as the signed-in member.",
  "theme.json": '{"accent":"#5B21B6","radius":"12px"}',
  "policy.json": '{"toolBudget":20}',
  "overrides.json": "{}",
};

function publishedResponse(): Response {
  return Response.json(
    { version: RELEASE_ID, config: PUBLISHED_CONFIG },
    { headers: { etag: ETAG } },
  );
}

describe("cloudConfig.fetch", () => {
  it("GETs /api/v1/config bearer-keyed with deployment identity and returns {version, config}", async () => {
    const seen: Array<{
      url: string;
      method: string;
      authorization: string | null;
      accept: string | null;
      ifNoneMatch: string | null;
      deploymentHost: string | null;
      signal: boolean;
    }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        ifNoneMatch: request.headers.get("if-none-match"),
        deploymentHost: request.headers.get("x-vendo-deployment-host"),
        signal: init?.signal instanceof AbortSignal,
      });
      return publishedResponse();
    });
    const client = cloudConfig({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.fetch()).resolves.toEqual({ version: RELEASE_ID, config: PUBLISHED_CONFIG });
    expect(seen[0]).toMatchObject({
      url: "https://cloud.test/api/v1/config",
      method: "GET",
      authorization: "Bearer vnd_secret",
      accept: "application/json",
      ifNoneMatch: null,
      signal: true,
    });
    expect(seen[0]!.deploymentHost).toEqual(expect.any(String));
    expect(seen[0]!.deploymentHost).not.toBe("");
  });

  it("defaults the base URL to the Vendo console", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => publishedResponse());
    const client = cloudConfig({ apiKey: "vnd_secret", fetch: fetchImpl });
    await client.fetch();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://console.vendo.run/api/v1/config");
  });

  it("returns the never-published sentinel {version: null, config: null}", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ version: null, config: null }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetch()).resolves.toEqual({ version: null, config: null });
  });

  it("sends If-None-Match with the cached ETag and applies a strong 304 as unchanged", async () => {
    let call = 0;
    const seen: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request.headers.get("if-none-match"));
      call += 1;
      if (call === 1) return publishedResponse();
      // 304 carries an empty body and echoes the ETag (fixture: not-modified).
      return new Response(null, { status: 304, headers: { etag: ETAG } });
    });
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.fetch()).resolves.toEqual({ version: RELEASE_ID, config: PUBLISHED_CONFIG });
    // Second fetch revalidates with the stored validator; the 304 yields the
    // same cached doc without a re-parse.
    await expect(client.fetch()).resolves.toEqual({ version: RELEASE_ID, config: PUBLISHED_CONFIG });
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe(ETAG);
  });

  it("maps the meter (402) and a bad key (401) to cloud-required with the server's message", async () => {
    for (const [status, message] of [[402, "Upgrade your Vendo Cloud plan"], [401, "invalid API key"]] as const) {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { code: "unauthorized", message } }, { status }));
      const client = cloudConfig({
        apiKey: "vnd_key",
        baseUrl: "https://cloud.test",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.fetch()).rejects.toMatchObject({ code: "cloud-required", message });
    }
  });

  it("a 304 with a cold cache fails loud as a plain Error (never an empty surface)", async () => {
    // We only send If-None-Match once we hold a validator, so a 304 with
    // nothing cached is the service misbehaving — surface it, don't silently
    // serve an empty config.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304, headers: { etag: ETAG } }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await client.fetch().then(
      () => { throw new Error("expected fetch to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.message).toMatch(/304|revalidate/i);
    expect(failure.code).toBeUndefined();
  });

  it("a console 5xx is a plain Error, never a caller validation error", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await client.fetch().then(
      () => { throw new Error("expected fetch to reject"); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(failure.code).not.toBe("validation");
    expect(failure.message).toMatch(/502/);
  });

  it("fails loud on a malformed 2xx (missing config keys) instead of trusting a misdeployed base", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ version: RELEASE_ID }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetch()).rejects.toThrow(/malformed|config/i);
  });

  it("fails loud on a 2xx whose config values are not strings", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ version: RELEASE_ID, config: { "theme.json": 42 } }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetch()).rejects.toThrow(/malformed|string/i);
  });

  it("aborts a hung console request after timeoutMs", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    await expect(client.fetch()).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("cloudConfig.snapshot (stale-while-revalidate)", () => {
  it("is cold (undefined) before the first successful fetch and warms after", async () => {
    const fetchImpl = vi.fn(async () => publishedResponse());
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(client.snapshot()).toBeUndefined();
    await client.fetch();
    expect(client.snapshot()).toEqual({ version: RELEASE_ID, config: PUBLISHED_CONFIG });
  });

  it("returns the cached value immediately and revalidates in the background once the TTL lapses", async () => {
    let clock = 1_000;
    let version = "v1";
    const fetchImpl = vi.fn(async () =>
      Response.json({ version, config: { "design-rules.md": version } }, { headers: { etag: `"${version}"` } }));
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
      ttlMs: 100,
      now: () => clock,
    });

    await client.fetch();
    expect(client.snapshot()).toEqual({ version: "v1", config: { "design-rules.md": "v1" } });

    // A console publish flips the version. Within the TTL, snapshot stays warm
    // and does NOT refetch.
    version = "v2";
    expect(client.snapshot()).toEqual({ version: "v1", config: { "design-rules.md": "v1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past the TTL, snapshot returns the stale value but kicks a background
    // refresh; the NEXT resolution sees the flipped version — no recomposition.
    clock += 200;
    expect(client.snapshot()).toEqual({ version: "v1", config: { "design-rules.md": "v1" } });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(client.snapshot()).toEqual({ version: "v2", config: { "design-rules.md": "v2" } });
  });

  it("swallows a background refresh failure and keeps serving the last good value", async () => {
    let clock = 1_000;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) return new Response("boom", { status: 502 });
      return publishedResponse();
    });
    const client = cloudConfig({
      apiKey: "vnd_key",
      baseUrl: "https://cloud.test",
      fetch: fetchImpl as unknown as typeof fetch,
      ttlMs: 100,
      now: () => clock,
    });
    await client.fetch();
    fail = true;
    clock += 200;
    expect(client.snapshot()).toEqual({ version: RELEASE_ID, config: PUBLISHED_CONFIG });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    // Still the last good value — a flaky console never blanks the surface.
    expect(client.snapshot()).toEqual({ version: RELEASE_ID, config: PUBLISHED_CONFIG });
  });
});
