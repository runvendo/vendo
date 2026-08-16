/** Portable key-authenticated console calls for RUNTIME code (capability
 *  misses today). The CLI's cloudFetch adds user sessions, refresh, and disk
 *  state on top — Node-only concerns that used to ride into Worker bundles
 *  whenever runtime code borrowed it. Keep this module free of node builtins
 *  and CLI imports; the portability gate bundles it. */
import { defaultFetch, deploymentIdentityHeaders } from "@vendoai/core";
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
  /** The key is always seam-supplied (adapter rule): callers pass it
   *  explicitly — this module never falls back to the environment for it. */
  apiKey: string;
  method?: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** POST/GET a console API path with seam-supplied bearer key auth. The
 *  console's shared auth middleware upserts deployment inventory and meters
 *  usage from the identity headers on real service calls
 *  (deployment-identity.ts). */
export async function cloudKeyFetch<T = unknown>(path: string, options: CloudKeyFetchOptions): Promise<T> {
  const token = options.apiKey;
  if (token === "") {
    throw new Error("Vendo Cloud key call without a key: the composition seam must pass a non-empty apiKey");
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
    // The status rides on the error so a caller can tell a verdict it must not
    // repeat (4xx) from a failure that may yet succeed (5xx, transport).
    throw Object.assign(new Error(`Vendo Cloud ${path} answered ${response.status}`), {
      status: response.status,
    });
  }
  // 204 is an answer with no body to parse; `.json()` on it throws, and a
  // route that says No Content (the config report) would look undelivered.
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
