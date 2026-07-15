import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CloudError } from "./client.js";
import { FREE_CONTRACT, parseContractV2, type ContractV2 } from "./entitlements.js";

export interface CachedEntitlements {
  fetched_at: number;
  contract: ContractV2;
}

export type EntitlementState = "fresh" | "cached" | "stale" | "degraded";

export interface EntitlementResolution {
  contract: ContractV2;
  state: EntitlementState;
  fetchedAt?: number;
}

export interface EntitlementsCacheOptions {
  home?: string;
  now?: number | (() => number);
}

export interface ResolveEntitlementsOptions extends EntitlementsCacheOptions {
  cacheKey: string;
  forceRefresh?: boolean;
}

export function entitlementsCacheKey(apiUrl: string, apiKey: string): string {
  return createHash("sha256").update(`${apiUrl}\n${apiKey}`, "utf8").digest("hex");
}

function entitlementsCachePath(options: EntitlementsCacheOptions): string {
  return join(options.home ?? homedir(), ".vendo", "entitlements.json");
}

function nowSeconds(options: EntitlementsCacheOptions): number {
  if (typeof options.now === "number") return Math.floor(options.now);
  if (options.now) return Math.floor(options.now());
  return Math.floor(Date.now() / 1_000);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readCacheFile(options: EntitlementsCacheOptions): Promise<Record<string, unknown> | null> {
  try {
    return objectValue(JSON.parse(await readFile(entitlementsCachePath(options), "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function readCachedEntitlements(
  cacheKey: string,
  options: EntitlementsCacheOptions = {},
): Promise<CachedEntitlements | null> {
  const cache = await readCacheFile(options);
  const entry = objectValue(cache?.[cacheKey]);
  if (!entry || typeof entry.fetched_at !== "number" || !Number.isFinite(entry.fetched_at)) return null;
  const contract = parseContractV2(entry.contract);
  return contract ? { fetched_at: entry.fetched_at, contract } : null;
}

async function writeCacheFile(
  cache: Record<string, unknown>,
  options: EntitlementsCacheOptions,
): Promise<void> {
  const path = entitlementsCachePath(options);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeCachedEntitlements(
  cacheKey: string,
  contract: ContractV2,
  options: EntitlementsCacheOptions = {},
): Promise<void> {
  const cache = await readCacheFile(options) ?? {};
  cache[cacheKey] = { fetched_at: nowSeconds(options), contract };
  await writeCacheFile(cache, options);
}

export async function dropCachedEntitlements(
  cacheKey: string,
  options: EntitlementsCacheOptions = {},
): Promise<void> {
  const cache = await readCacheFile(options);
  if (!cache) {
    await rm(entitlementsCachePath(options), { force: true });
    return;
  }
  delete cache[cacheKey];
  await writeCacheFile(cache, options);
}

function retryable(error: unknown): boolean {
  return !(error instanceof CloudError) || error.status === 0 || error.status === 503;
}

export async function resolveEntitlements(
  fetchContract: () => Promise<ContractV2>,
  options: ResolveEntitlementsOptions,
): Promise<EntitlementResolution> {
  const now = nowSeconds(options);
  const cached = await readCachedEntitlements(options.cacheKey, options);
  if (cached && !options.forceRefresh
    && now - cached.fetched_at < cached.contract.cache.ttl_seconds) {
    return { contract: cached.contract, state: "cached", fetchedAt: cached.fetched_at };
  }

  try {
    const contract = parseContractV2(await fetchContract());
    if (!contract) throw new CloudError("invalid-contract", "Vendo Cloud returned an invalid contract", 500);
    await writeCachedEntitlements(options.cacheKey, contract, { ...options, now });
    return { contract, state: "fresh", fetchedAt: now };
  } catch (error) {
    if (error instanceof CloudError && error.status === 401) {
      await dropCachedEntitlements(options.cacheKey, options);
      throw error;
    }
    if (!retryable(error)) throw error;
    if (cached && now - cached.fetched_at < cached.contract.cache.stale_if_error_seconds) {
      return { contract: cached.contract, state: "stale", fetchedAt: cached.fetched_at };
    }
    return { contract: FREE_CONTRACT, state: "degraded" };
  }
}
