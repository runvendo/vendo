import { VendoError, type AppDocument, type AppId } from "@vendoai/core";
import {
  publishRecordSchema,
  shareSnapshotSchema,
  type CloudAppsClient,
} from "@vendoai/apps";
import { consoleSender, raiseCloudError } from "./cloud-console.js";

/** The Cloud share/publish client — the implementation the composition seam
 * (createVendo) injects into the apps block's CloudAppsClient seam when
 * VENDO_API_KEY fills the unset slot (adapter rule — see selectConnections in
 * server.ts; the block itself never reads the environment). Rides the shared
 * console-client plumbing (cloud-console.ts): Bearer auth + deployment
 * identity + per-request abort timeout + the honest 401/402 → cloud-required
 * error table. */

export interface CloudAppsOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request abort budget (default 30s, hosted-store's). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The console mounts the share/publish surface here. */
const CONSOLE_APPS_PATH = "/api/v1/apps";

/** Shared console error table: 401/402 → cloud-required, wire-legal envelope
 * codes forward as VendoErrors, anything else (unknown codes, 5xx, non-JSON
 * bodies) rides a plain Error with the server's code attached — never a
 * "validation" error blaming the caller for the console misbehaving. */
const raiseAppsError = (response: Response): Promise<never> =>
  raiseCloudError(response, "apps", (code, message) => {
    throw Object.assign(new Error(message), { code: code ?? "unavailable" });
  });

export function cloudApps(options: CloudAppsOptions): CloudAppsClient {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const send = consoleSender({
    base,
    mountPath: CONSOLE_APPS_PATH,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? globalThis.fetch,
    raise: raiseAppsError,
  });

  const post = async <T>(
    path: "/share" | "/publish",
    appId: AppId,
    doc: AppDocument,
    schema: { parse(value: unknown): T },
  ): Promise<T> => {
    const response = await send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, doc }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // hosted-store's malformed-200 posture: a 2xx that isn't JSON means a
      // misdeployed Cloud base — fail loudly instead of a schema error.
      throw new VendoError(
        "validation",
        `Vendo Cloud apps returned a non-JSON ${response.status} response — check VENDO_CLOUD_URL`,
      );
    }
    return schema.parse(payload);
  };

  return {
    share: (appId, doc) => post("/share", appId, doc, shareSnapshotSchema),
    publish: (appId, doc) => post("/publish", appId, doc, publishRecordSchema),
  };
}
