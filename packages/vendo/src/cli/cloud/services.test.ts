import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudError } from "./client.js";
import {
  entitlementsCacheKey,
  readCachedEntitlements,
  writeCachedEntitlements,
} from "./entitlements-cache.js";
import { type ContractV2 } from "./entitlements.js";
import { runPinShip, runPublish, runShare, runValidate } from "./services.js";

const VALID_KEY = `vnd_${"a".repeat(40)}`;
const API_URL = "https://console.vendo.run";
const contract: ContractV2 = {
  valid: true,
  contract_version: 2,
  org: { id: "org_1", name: "Acme Inc", slug: "acme" },
  plan: { id: "pro", name: "Pro", status: "active" },
  capabilities: {
    sharing: true,
    registry: true,
    guard_basic: true,
    pinning: false,
    guard_full: false,
    session_replay: false,
    insights: false,
    mcp_broker: false,
    sso_saml: false,
    orgs: false,
  },
  limits: {
    sandbox_minutes: { included: 5000, used: 1234, remaining: 3766, exhausted: false },
    runs: { included: 25000, used: 0, remaining: 25000, exhausted: false },
    storage_gb: { included: 10, used: 0.4, remaining: 9.6, exhausted: false },
  },
  cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
};

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vendo-cloud-services-"));
  cleanup.push(path);
  return path;
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

describe("cloud services", () => {
  it("renders a live contract v2 response and caches it", async () => {
    const root = await home();
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue(contract);

    expect(await runValidate(["--key", VALID_KEY], {
      output: messages.sink, fetcher, home: root, now: () => 1_000,
    })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/keys/validate", expect.objectContaining({
      auth: "key",
      apiKey: VALID_KEY,
      method: "POST",
    }));
    expect(messages.logs[0]).toContain("Vendo Cloud key: valid");
    expect(messages.logs[0]).toContain("Capabilities");
    expect(await readCachedEntitlements(entitlementsCacheKey(API_URL, VALID_KEY), { home: root })).toEqual({
      fetched_at: 1_000,
      contract,
    });
  });

  it("prints a contract v2 response as JSON with --json", async () => {
    const root = await home();
    const messages = output();
    expect(await runValidate(["--key", VALID_KEY, "--json"], {
      output: messages.sink, fetcher: vi.fn().mockResolvedValue(contract), home: root,
    })).toBe(0);
    expect(JSON.parse(messages.logs[0]!)).toEqual(contract);
  });

  it("passes a non-v2 response through unchanged", async () => {
    const messages = output();
    const legacy = { valid: true, entitlements: ["sharing"] };
    expect(await runValidate(["--key", VALID_KEY], {
      output: messages.sink, fetcher: vi.fn().mockResolvedValue(legacy),
    })).toBe(0);
    expect(JSON.parse(messages.logs[0]!)).toEqual(legacy);
  });

  it.each([
    ["validate", (fetcher: ReturnType<typeof vi.fn>) => runValidate(["--key", "vnd_test"], { output: output().sink, fetcher })],
    ["share", (fetcher: ReturnType<typeof vi.fn>) => runShare(["missing.json", "--key", "vnd_test"], { output: output().sink, fetcher })],
    ["publish", (fetcher: ReturnType<typeof vi.fn>) => runPublish(["missing.json", "--key", "vnd_test"], { output: output().sink, fetcher })],
    ["pin-ship", (fetcher: ReturnType<typeof vi.fn>) => runPinShip([
      "--app", "app_1", "--slot", "main", "--base", "hash", "--diff", "missing.diff", "--key", "vnd_test",
    ], { output: output().sink, fetcher })],
  ])("rejects a malformed key before the %s request", async (_command, run) => {
    const fetcher = vi.fn();
    expect(await run(fetcher)).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("prints the exact malformed key error", async () => {
    const messages = output();
    expect(await runValidate(["--key", "vnd_test"], { output: messages.sink, fetcher: vi.fn() })).toBe(1);
    expect(messages.errors).toEqual(["Invalid API key format (expected vnd_ followed by 40 hex characters)"]);
  });

  it("uses a stale contract when the console is unavailable", async () => {
    const root = await home();
    const messages = output();
    const cacheKey = entitlementsCacheKey(API_URL, VALID_KEY);
    await writeCachedEntitlements(cacheKey, contract, { home: root, now: () => 1_000 });

    expect(await runValidate(["--key", VALID_KEY], {
      output: messages.sink,
      fetcher: vi.fn().mockRejectedValue(new CloudError("unavailable", "offline", 503)),
      home: root,
      now: () => 2_000,
    })).toBe(0);
    expect(messages.logs[0]).toMatch(/^stale since 1970-01-01T00:16:40.000Z \(console unreachable\)/);
  });

  it("keeps --json output machine-readable when serving the stale cache", async () => {
    const root = await home();
    const messages = output();
    const cacheKey = entitlementsCacheKey(API_URL, VALID_KEY);
    await writeCachedEntitlements(cacheKey, contract, { home: root, now: () => 1_000 });

    expect(await runValidate(["--key", VALID_KEY, "--json"], {
      output: messages.sink,
      fetcher: vi.fn().mockRejectedValue(new CloudError("unavailable", "offline", 503)),
      home: root,
      now: () => 2_000,
    })).toBe(0);
    expect(JSON.parse(messages.logs[0]!)).toEqual(contract);
  });

  it("degrades to free entitlements and exits one beyond the stale window", async () => {
    const root = await home();
    const messages = output();
    expect(await runValidate(["--key", VALID_KEY], {
      output: messages.sink,
      fetcher: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      home: root,
      now: () => 100_000,
    })).toBe(1);
    expect(messages.logs[0]).toMatch(/^degraded to free entitlements \(console unreachable > 24h\)/);
    expect(messages.logs[0]).toContain("Plan: Free (degraded)");
  });

  it("drops cached entitlements and exits one on a 401", async () => {
    const root = await home();
    const messages = output();
    const cacheKey = entitlementsCacheKey(API_URL, VALID_KEY);
    await writeCachedEntitlements(cacheKey, contract, { home: root, now: () => 1_000 });

    expect(await runValidate(["--key", VALID_KEY], {
      output: messages.sink,
      fetcher: vi.fn().mockRejectedValue(new CloudError("unauthorized", "Invalid key", 401)),
      home: root,
      now: () => 2_000,
    })).toBe(1);
    expect(messages.errors).toEqual(["Invalid key"]);
    expect(await readCachedEntitlements(cacheKey, { home: root })).toBeNull();
  });

  it("maps an envelope-less 401 to a friendly invalid-key message", async () => {
    const messages = output();
    expect(await runValidate(["--key", VALID_KEY], {
      output: messages.sink,
      fetcher: vi.fn().mockRejectedValue(new CloudError("http-401", "Vendo Cloud request failed (401)", 401)),
      home: await home(),
    })).toBe(1);
    expect(messages.errors).toEqual(["Invalid or revoked API key (401)"]);
  });

  it("wraps a shared app document with its id", async () => {
    const root = await home();
    const file = join(root, "app.json");
    const doc = { id: "accounting", root: "card" };
    await writeFile(file, JSON.stringify(doc));
    const fetcher = vi.fn().mockResolvedValue({ id: "shr_1", doc });

    expect(await runShare([file, `--key=${VALID_KEY}`], { output: output().sink, fetcher, env: {} })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/apps/share", expect.objectContaining({
      body: { appId: "accounting", doc },
    }));
  });

  it("allows --app to override the published document id", async () => {
    const root = await home();
    const file = join(root, "app.json");
    const doc = { id: "file-id", root: "card" };
    await writeFile(file, JSON.stringify(doc));
    const fetcher = vi.fn().mockResolvedValue({ id: "pub_1", appId: "override-id" });

    expect(await runPublish([
      file, "--app", "override-id", `--key=${VALID_KEY}`,
    ], { output: output().sink, fetcher, env: {} })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/apps/publish", expect.objectContaining({
      body: { appId: "override-id", doc },
    }));
  });

  it("reads a textual diff for pin shipping", async () => {
    const root = await home();
    const file = join(root, "change.diff");
    await writeFile(file, "@@ -1 +1 @@\n-old\n+new\n");
    const fetcher = vi.fn().mockResolvedValue({ id: "pin_1", status: "pending" });

    expect(await runPinShip([
      "--app", "app_1", "--slot", "main", "--base", "hash", "--diff", file, "--key", VALID_KEY,
    ], { output: output().sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/pins/ship", expect.objectContaining({
      body: { appId: "app_1", slot: "main", baseHash: "hash", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    }));
  });

  it("prints a friendly cloud-required error", async () => {
    const messages = output();
    const fetcher = vi.fn().mockRejectedValue(new CloudError("cloud-required", "Upgrade", 402));
    expect(await runValidate(["--key", VALID_KEY], { output: messages.sink, fetcher })).toBe(1);
    expect(messages.errors).toEqual(["This key's org needs a Cloud plan (cloud-required)."]);
  });
});
