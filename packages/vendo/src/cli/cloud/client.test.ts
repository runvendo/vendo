import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudError, cloudFetch, isVendoKey, resolveCloudBaseUrl } from "./client.js";
import { CLI_VERSION } from "../shared.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function projectDir(packageName?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-cloud-client-"));
  cleanup.push(root);
  if (packageName !== undefined) await writeFile(join(root, "package.json"), JSON.stringify({ name: packageName }));
  return root;
}

async function keyedRequestHeaders(cwd: string): Promise<Record<string, string>> {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  await cloudFetch("/api/v1/apps/share", { auth: "key", apiKey: "vnd_test", fetchImpl });
  return (fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
}

describe("cloud client", () => {
  it("resolves the explicit URL before the environment and default", () => {
    expect(resolveCloudBaseUrl({
      apiUrl: "https://example.test/root/",
      env: { VENDO_CLOUD_URL: "https://ignored.test" },
    })).toBe("https://example.test/root");
    expect(resolveCloudBaseUrl({ env: { VENDO_CLOUD_URL: "https://env.test/" } })).toBe("https://env.test");
    expect(resolveCloudBaseUrl({ env: {} })).toBe("https://console.vendo.run");
  });

  it("turns API error envelopes into CloudError instances", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      error: { code: "cloud-required", message: "Upgrade required" },
    }, { status: 402 }));

    await expect(cloudFetch("/api/v1/apps/share", {
      auth: "key",
      apiKey: "vnd_test",
      fetchImpl,
    })).rejects.toMatchObject<Partial<CloudError>>({
      name: "CloudError",
      code: "cloud-required",
      message: "Upgrade required",
      status: 402,
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ "user-agent": `vendo-cli/${CLI_VERSION}` }),
    }));
  });

  it("attaches the deployment-identity headers to every key-authed request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ok: true }));

    await cloudFetch("/api/v1/apps/share", { auth: "key", apiKey: "vnd_test", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({
        "x-vendo-deployment-host": expect.any(String),
        "x-vendo-deployment-name": expect.any(String),
      }),
    }));
  });

  it("names the deployment after the cwd package, falling back to the directory", async () => {
    expect((await keyedRequestHeaders(await projectDir("acme-books")))["x-vendo-deployment-name"]).toBe("acme-books");
    const bare = await projectDir();
    expect((await keyedRequestHeaders(bare))["x-vendo-deployment-name"]).toBe(basename(bare));
  });

  it("sanitizes deployment-identity header values to printable ASCII", async () => {
    // Non-Latin-1 header values make fetch throw "Cannot convert argument to
    // a ByteString"; the identity headers must never take a command down.
    const headers = await keyedRequestHeaders(await projectDir("café-livres\r\n"));
    expect(headers["x-vendo-deployment-name"]).toBe("caf-livres");
    expect(headers["x-vendo-deployment-host"]).toBe(hostname().replace(/[^\x20-\x7e]+/g, "").trim());
  });

  it("falls back to unknown when nothing printable survives sanitizing", async () => {
    const headers = await keyedRequestHeaders(await projectDir("日本語"));
    expect(headers["x-vendo-deployment-name"]).toBe("unknown");
  });

  it("omits the deployment-identity headers on user-authed requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json([]));

    await cloudFetch("/api/v1/orgs", { auth: "user", accessToken: "jwt", fetchImpl });
    const headers = (fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty("x-vendo-deployment-host");
    expect(headers).not.toHaveProperty("x-vendo-deployment-name");
  });

  it.each([
    [`vnd_${"0a".repeat(20)}`, true],
    [`vnd_${"f".repeat(40)}`, true],
    ["vnd_test", false],
    [`vnd_${"A".repeat(40)}`, false],
    [`vnd_${"a".repeat(39)}`, false],
    [`xvnd_${"a".repeat(40)}`, false],
  ])("checks API key format for %s", (key, valid) => {
    expect(isVendoKey(key)).toBe(valid);
  });

  it("refreshes a user session once after a 401 and retries the request", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "unauthorized", message: "Expired" } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "fresh", refresh_token: "next", expires_at: 2_000_000_000 }))
      .mockResolvedValueOnce(Response.json([{ id: "org_1" }]));
    const writeSession = vi.fn();

    await expect(cloudFetch("/api/v1/orgs", {
      auth: "user",
      fetchImpl,
      sessionStore: {
        read: async () => ({ access_token: "old", refresh_token: "refresh", expires_at: 2_000_000_000 }),
        write: writeSession,
      },
    })).resolves.toEqual([{ id: "org_1" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({ headers: expect.objectContaining({ "user-agent": `vendo-cli/${CLI_VERSION}` }) });
    }
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer fresh" }) });
    expect(writeSession).toHaveBeenCalledWith({ access_token: "fresh", refresh_token: "next", expires_at: 2_000_000_000 });
  });
});
