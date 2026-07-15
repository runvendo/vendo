import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudError } from "./client.js";
import {
  dropCachedEntitlements,
  entitlementsCacheKey,
  readCachedEntitlements,
  resolveEntitlements,
  writeCachedEntitlements,
} from "./entitlements-cache.js";
import { FREE_CONTRACT, type ContractV2 } from "./entitlements.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const contract: ContractV2 = {
  valid: true,
  contract_version: 2,
  org: { id: "org_1", name: "Acme", slug: "acme" },
  plan: { id: "pro", name: "Pro", status: "active" },
  capabilities: {
    sharing: true,
    registry: false,
    guard_basic: false,
    pinning: false,
    guard_full: false,
    session_replay: false,
    insights: false,
    mcp_broker: false,
    sso_saml: false,
    orgs: false,
  },
  limits: {
    sandbox_minutes: { included: 100, used: 10, remaining: 90, exhausted: false },
    runs: { included: 0, used: 0, remaining: 0, exhausted: false },
    storage_gb: { included: 0, used: 0, remaining: 0, exhausted: false },
  },
  cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
};

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vendo-entitlements-"));
  cleanup.push(path);
  return path;
}

describe("entitlements disk cache", () => {
  it("hashes the URL and key without exposing the raw key", () => {
    const key = entitlementsCacheKey("https://console.example", "vnd_secret");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("vnd_secret");
    expect(key).toBe(entitlementsCacheKey("https://console.example", "vnd_secret"));
  });

  it("round-trips and drops an entry with owner-only permissions", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });

    expect(await readCachedEntitlements("hash", { home: root })).toEqual({ fetched_at: 1_000, contract });
    const path = join(root, ".vendo", "entitlements.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("vnd_");

    await dropCachedEntitlements("hash", { home: root });
    expect(await readCachedEntitlements("hash", { home: root })).toBeNull();
  });

  it("returns null for a corrupt cache file", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    await writeFile(join(root, ".vendo", "entitlements.json"), "not json");
    await expect(readCachedEntitlements("hash", { home: root })).resolves.toBeNull();
  });
});

describe("entitlement resolution", () => {
  it("writes a successful network contract as fresh", async () => {
    const root = await home();
    const fetchContract = vi.fn().mockResolvedValue(contract);
    await expect(resolveEntitlements(fetchContract, {
      cacheKey: "hash", home: root, now: () => 1_000,
    })).resolves.toEqual({ contract, state: "fresh", fetchedAt: 1_000 });
    expect(await readCachedEntitlements("hash", { home: root })).toEqual({ fetched_at: 1_000, contract });
  });

  it("uses a young cached contract without a network request", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    const fetchContract = vi.fn();
    await expect(resolveEntitlements(fetchContract, {
      cacheKey: "hash", home: root, now: () => 1_500,
    })).resolves.toEqual({ contract, state: "cached", fetchedAt: 1_000 });
    expect(fetchContract).not.toHaveBeenCalled();
  });

  it("forces a refresh even when the cache is young", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    const refreshed = { ...contract, org: { ...contract.org, name: "Updated" } };
    const fetchContract = vi.fn().mockResolvedValue(refreshed);
    await expect(resolveEntitlements(fetchContract, {
      cacheKey: "hash", home: root, now: () => 1_100, forceRefresh: true,
    })).resolves.toEqual({ contract: refreshed, state: "fresh", fetchedAt: 1_100 });
  });

  it.each([
    new CloudError("unavailable", "offline", 503),
    new CloudError("network", "offline", 0),
    new TypeError("fetch failed"),
  ])("uses stale cache during a retryable failure", async (error) => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    await expect(resolveEntitlements(async () => { throw error; }, {
      cacheKey: "hash", home: root, now: () => 2_000, forceRefresh: true,
    })).resolves.toEqual({ contract, state: "stale", fetchedAt: 1_000 });
  });

  it("degrades to fail-closed free entitlements beyond the stale window", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    await expect(resolveEntitlements(async () => { throw new TypeError("fetch failed"); }, {
      cacheKey: "hash", home: root, now: () => 90_000, forceRefresh: true,
    })).resolves.toEqual({ contract: FREE_CONTRACT, state: "degraded" });
  });

  it("drops cached entitlements and rethrows a 401", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    const error = new CloudError("unauthorized", "Invalid key", 401);
    await expect(resolveEntitlements(async () => { throw error; }, {
      cacheKey: "hash", home: root, now: () => 2_000, forceRefresh: true,
    })).rejects.toBe(error);
    expect(await readCachedEntitlements("hash", { home: root })).toBeNull();
  });

  it("rethrows non-retryable cloud errors without grace", async () => {
    const root = await home();
    await writeCachedEntitlements("hash", contract, { home: root, now: () => 1_000 });
    const error = new CloudError("server-error", "Broken", 500);
    await expect(resolveEntitlements(async () => { throw error; }, {
      cacheKey: "hash", home: root, now: () => 2_000, forceRefresh: true,
    })).rejects.toBe(error);
  });
});
