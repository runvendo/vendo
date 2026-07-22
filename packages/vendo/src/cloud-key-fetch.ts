/** Portable key-authenticated console calls for RUNTIME code (capability
 *  misses today). The CLI's cloudFetch adds user sessions, refresh, and disk
 *  state on top — Node-only concerns that used to ride into Worker bundles
 *  whenever runtime code borrowed it. Keep this module free of node builtins
 *  and CLI imports; the portability gate bundles it. */
import { defaultFetch } from "@vendoai/core";

import { deploymentIdentityHeaders } from "./deployment-identity.js";
import { VERSION } from "./wire/shared.js";

const DEFAULT_CLOUD_URL = "https://console.vendo.run";

export interface CloudUrlOptions {
  apiUrl?: string;
  env?: Record<string, string | undefined>;
}

const processEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export function resolveCloudBaseUrl(options: CloudUrlOptions = {}): string {
  const value = options.apiUrl ?? (options.env ?? processEnv()).VENDO_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  return value.replace(/\/+$/, "");
}

export interface CloudKeyFetchOptions extends CloudUrlOptions {
  apiKey?: string;
  method?: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** POST/GET a console API path with VENDO_API_KEY bearer auth. The console's
 *  shared auth middleware upserts deployment inventory and meters usage from
 *  the identity headers on real service calls (deployment-identity.ts). */
export async function cloudKeyFetch<T = unknown>(path: string, options: CloudKeyFetchOptions = {}): Promise<T> {
  const token = options.apiKey ?? (options.env ?? processEnv()).VENDO_API_KEY;
  if (token === undefined || token === "") {
    throw new Error("Vendo Cloud key call without a key: pass apiKey or set VENDO_API_KEY");
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": `vendo-cli/${VERSION}`,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(await deploymentIdentityHeaders()),
  };
  const response = await (options.fetchImpl ?? defaultFetch)(`${resolveCloudBaseUrl(options)}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new Error(`Vendo Cloud ${path} answered ${response.status}`);
  }
  return await response.json() as T;
}
