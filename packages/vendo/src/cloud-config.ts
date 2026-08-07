import { VendoError } from "@vendoai/core";
import { defaultFetch } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";

/** The Cloud hosted-config client — the read half of the config-resolution seam
 * (cse lane 3). The composition seam (selectConfigSurface in server.ts) consults
 * it for a `.vendo` surface the host neither set programmatically nor keeps on
 * local disk; it is the Cloud DEFAULT that VENDO_API_KEY fills at the seam
 * (adapter rule — see selectConnections/selectStore). Like every Cloud adapter,
 * behavior comes ONLY from constructor arguments; nothing here reads the
 * environment. Worker-portable: no `node:*` import (the identity headers load
 * their builtins through the runtime accessor — deployment-identity.ts).
 *
 * ── WIRE CONTRACT (apps/console/fixtures/config-wire/) ─────────────────────
 * GET  <console>/api/v1/config
 *   Authorization: Bearer vnd_...            (key-authed data plane)
 *   x-vendo-deployment-host / -name          (usage metering; no heartbeat)
 *   If-None-Match: "<releaseId>"             (optional; strong validator)
 * →  200 { version: <releaseId>, config: { "<surface>": "<file body>", ... } }
 *      ETag: "<releaseId>"                    (strong; the release id, quoted)
 * →  200 { version: null, config: null }      never published (NOT a 404)
 * →  304 (empty body, ETag echoed)            unchanged since If-None-Match;
 *                                             strong comparison — a W/ validator
 *                                             never matches (we send/keep strong)
 * →  401 / 402                                → VendoError("cloud-required")
 * →  5xx / other non-2xx / malformed 2xx      → plain Error (service misbehaving,
 *                                             never the caller's fault)
 * The config doc keys mirror the `.vendo` file NAMES ("design-rules.md",
 * "brief.md", "theme.json", "policy.json", "overrides.json"); values are the
 * file bodies as strings.
 */

/** The published config doc: a flat map of `.vendo` surface name → file body. */
export type CloudConfigDoc = Record<string, string>;

/** The published-config read result. `{version: null, config: null}` is the
 * never-published sentinel — a first-boot deployment needs no special casing. */
export interface CloudConfigResult {
  version: string | null;
  config: CloudConfigDoc | null;
}

export interface CloudConfigOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request abort budget (default 30s, the shared console-client default). */
  timeoutMs?: number;
  /** Stale-while-revalidate window for `snapshot()` (default 30s — see
   * DEFAULT_CONFIG_TTL_MS). */
  ttlMs?: number;
  /** Clock seam (tests only). */
  now?: () => number;
}

export interface CloudConfig {
  /** The authoritative async read: revalidates against the stored strong ETag,
   * updates the snapshot cache, and returns the parsed result (or throws). Used
   * by the CLI/doctor and to warm the snapshot at compose time. */
  fetch(): Promise<CloudConfigResult>;
  /** The SYNC stale-while-revalidate read the per-generation thunks use
   * (design-rules resolves synchronously per create/edit). Returns the last
   * good value immediately; when the cache is older than `ttlMs` it kicks a
   * single background revalidation (errors swallowed — a flaky console never
   * blanks the surface) but still returns the current value. `undefined` = the
   * cache is cold (no successful fetch yet). */
  snapshot(): CloudConfigResult | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** design-rules is re-resolved once per app create/edit — seconds to minutes
 * apart — so a 30s revalidation window bounds how long a console publish takes
 * to show up (one generation cycle) without turning every generation into a
 * blocking console round-trip: `snapshot()` never blocks, it revalidates in the
 * background. Matches the request timeout so a hung revalidation cannot outlive
 * the window it was kicked for. */
const DEFAULT_CONFIG_TTL_MS = 30_000;

function isConfigDoc(value: unknown): value is CloudConfigDoc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/** Parse and validate a 200 body. A misdeployed/misbehaving console is the
 * SERVICE's fault, never the caller's, so a malformed shape is a plain Error —
 * never a wire-legal "validation" VendoError that would blame host input. */
function parseResult(payload: unknown): CloudConfigResult {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Vendo Cloud config returned a malformed response — check VENDO_CLOUD_URL");
  }
  const { version, config } = payload as { version?: unknown; config?: unknown };
  const versionOk = version === null || typeof version === "string";
  const configOk = config === null || isConfigDoc(config);
  if (!versionOk || !configOk) {
    throw new Error(
      "Vendo Cloud config returned a malformed {version, config} doc (values must be strings) — check VENDO_CLOUD_URL",
    );
  }
  return { version: version as string | null, config: config as CloudConfigDoc | null };
}

export function cloudConfig(options: CloudConfigOptions): CloudConfig {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIG_TTL_MS;
  const now = options.now ?? Date.now;

  let cached: CloudConfigResult | undefined;
  let etag: string | undefined;
  let fetchedAt = 0;
  let inflight: Promise<CloudConfigResult> | undefined;

  async function send(): Promise<CloudConfigResult> {
    const response = await fetchImpl(`${base}/api/v1/config`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        ...(await deploymentIdentityHeaders()),
        // Strong validator — we only ever store/send the quoted release id, so
        // the console's strong comparison can answer 304.
        ...(etag === undefined ? {} : { "if-none-match": etag }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 304) {
      if (cached === undefined) {
        // A 304 with nothing cached means we sent a validator we no longer
        // trust; treat it as service misbehavior rather than an empty surface.
        throw new Error("Vendo Cloud config returned 304 with no cached release to revalidate");
      }
      fetchedAt = now();
      return cached;
    }

    if (response.status === 401 || response.status === 402) {
      let message = `Vendo Cloud config request failed with ${response.status}`;
      try {
        const body = JSON.parse(await response.text()) as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch {
        // keep the default message
      }
      throw new VendoError("cloud-required", message);
    }

    if (!response.ok) {
      throw new Error(`Vendo Cloud config request failed with ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Vendo Cloud config returned a non-JSON 2xx response — check VENDO_CLOUD_URL");
    }
    const result = parseResult(payload);
    const nextEtag = response.headers.get("etag");
    etag = nextEtag !== null && !nextEtag.startsWith("W/") ? nextEtag : undefined;
    cached = result;
    fetchedAt = now();
    return result;
  }

  function fetchDeduped(): Promise<CloudConfigResult> {
    // Collapse concurrent reads (a snapshot()-kicked revalidation racing an
    // explicit fetch()) onto one in-flight request.
    inflight ??= send().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return {
    fetch: fetchDeduped,
    snapshot() {
      if (cached === undefined) {
        // Cold: kick a warmup but don't block the caller (the thunk returns
        // undefined this round; the next resolution sees the warmed value).
        if (inflight === undefined) void fetchDeduped().catch(() => undefined);
        return undefined;
      }
      if (now() - fetchedAt > ttlMs && inflight === undefined) {
        void fetchDeduped().catch(() => undefined);
      }
      return cached;
    },
  };
}
