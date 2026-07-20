import { VendoError, type VendoErrorCode } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";

/** Console-client plumbing shared by the Cloud adapters (cloudSandbox,
 * hostedStore, cloudConnections, cloudApps): the wire-legal error table, the
 * enveloped-error raise, and the key-authed sender. Behavior still comes
 * ONLY from each adapter's constructor arguments (adapter rule — see
 * selectSandbox/selectStore in server.ts); nothing here reads the
 * environment. */

/** Console error codes forwarded as-is when they are wire-legal VendoError
 * codes (same posture as the cloudApps share/publish client). The
 * console's "unavailable"/"unauthorized"/"quota-exhausted" have no VendoError
 * twin; unknown codes fall to each adapter's own tail, and the 402/401 →
 * cloud-required mapping handles the meter/key cases. */
export const CLOUD_ERROR_CODES: ReadonlySet<string> = new Set([
  "validation",
  "blocked",
  "not-implemented",
  "cloud-required",
  "not-found",
  "conflict",
] satisfies VendoErrorCode[]);

export const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

/** Parse the console's error envelope and throw. The console's meter gate
 * (quota-exhausted) rides HTTP 402 — the one "pay/upgrade to proceed" signal,
 * same mapping as cloudConnections. 401 (bad/revoked key) is the same "fix
 * your Cloud standing" story for the host operator, so it keeps the ENG-295
 * client's cloud-required mapping — with the server's own message preserved.
 * Wire-legal codes forward as VendoErrors; anything else (unknown codes, 5xx,
 * non-JSON bodies) goes to the adapter's own `onUnknownCode` tail. */
export async function raiseCloudError(
  response: Response,
  service: string,
  onUnknownCode: (code: string | undefined, message: string) => never,
): Promise<never> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = undefined;
  }
  const error = typeof payload === "object" && payload !== null && "error" in payload
    ? (payload as { error?: { code?: unknown; message?: unknown } }).error
    : undefined;
  const message = typeof error?.message === "string"
    ? error.message
    : `Vendo Cloud ${service} request failed with ${response.status}`;
  if (response.status === 402 || response.status === 401) {
    throw new VendoError("cloud-required", message);
  }
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code !== undefined && CLOUD_ERROR_CODES.has(code)) {
    throw new VendoError(code as VendoErrorCode, message);
  }
  return onUnknownCode(code, message);
}

/** The key-authed console sender: Bearer auth + deployment identity (the
 * console meters usage from real traffic) + per-request abort timeout, raising
 * through the adapter's own error mapping on any non-2xx. */
export function consoleSender(options: {
  base: string;
  mountPath: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  raise: (response: Response) => Promise<never>;
}): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init = {}) => {
    const response = await options.fetchImpl(`${options.base}${options.mountPath}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        ...(await deploymentIdentityHeaders()),
        ...init.headers,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) await options.raise(response);
    return response;
  };
}
