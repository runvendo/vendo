/** The config REPORT — one-way, lazy, and the ONLY thing the console has to do
 * with config. Resolution is code-only, forever (value passed in code →
 * `.vendo/<name>` file → not set); a keyed runtime tells the console what it
 * resolved TO, and the console never answers back.
 *
 * ── WIRE CONTRACT (tests/fixtures/config-wire/) ────────────────────────────
 * PUT  <console>/api/v1/config/report
 *   Authorization: Bearer vnd_...            (key-authed data plane)
 *   x-vendo-deployment-host / -name          (the identity every keyed call
 *                                            already carries — cloud-key-fetch)
 *   { "surfaces": { "<name>": { "source": "file"|"code"|"unset",
 *                               "content": string|null } } }
 * →  204 No Content
 * All five `.vendo` surface names are ALWAYS present, and `content` is null if
 * and only if `source` is `"unset"`. The 512KB/surface and 2MB/doc caps are the
 * console's to enforce; an over-cap doc is refused there and the uploader drops
 * its copy like any other undelivered batch.
 */
import { canonicalJson, sha256Hex } from "@vendoai/core";
import { createBatchedUploader } from "./batched-uploader.js";
import { CONFIG_SURFACES, selectConfigSurface, type ConfigSurfaceName } from "./config-surface.js";

const REPORT_PATH = "/api/v1/config/report";

interface ConfigReport {
  surfaces: Record<ConfigSurfaceName, { source: "file" | "code" | "unset"; content: string | null }>;
}

export interface ConfigReporterOptions {
  /** ADAPTER RULE, report slot: filled by the composition seam
   *  (`cloudKeyOptions()`), never read from the environment here. Unset is a
   *  keyless deployment, and a keyless deployment reports nothing, ever. */
  cloud?: { apiKey: string; baseUrl?: string } | undefined;
  /** The `.vendo/<name>` reader, bound to the compose-time surface root. */
  readFile: (name: ConfigSurfaceName) => string | undefined;
  /** What this deployment set for a surface IN CODE, as the bytes the matching
   *  `.vendo` file would have carried. */
  codeValue: (name: ConfigSurfaceName) => string | undefined;
  fetchImpl?: typeof fetch;
}

/** Returns the per-resolution-cycle hook: it re-resolves all five surfaces,
 *  hashes them, and pushes a report only when the hash moved. Boot's first
 *  resolution is what sends the initial one — there is no heartbeat and no
 *  timer of its own. */
export function createConfigReporter(options: ConfigReporterOptions): () => void {
  if (options.cloud === undefined) return () => undefined;
  const uploader = createBatchedUploader<ConfigReport>({
    path: REPORT_PATH,
    method: "PUT",
    cloud: options.cloud,
    // The console wants the config this deployment is running NOW, not a
    // history of it, so a batch collapses to its newest report.
    body: (reports) => reports[reports.length - 1],
    // 204 No Content is the whole answer; cloudKeyFetch already threw on any
    // non-2xx, so reaching here IS delivery.
    accept: () => true,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  // Deduped at ENQUEUE, matching the miss/event streams: an undelivered batch
  // is dropped rather than retried forever, and the next CHANGE reports again.
  let lastHash: string | undefined;
  return () => {
    const surfaces = {} as ConfigReport["surfaces"];
    for (const name of CONFIG_SURFACES) {
      const { owner, value } = selectConfigSurface(name, {
        ...(options.codeValue(name) === undefined ? {} : { explicit: options.codeValue(name) }),
        readFile: options.readFile,
      });
      surfaces[name] = value === undefined
        ? { source: "unset", content: null }
        : { source: owner === "explicit" ? "code" : "file", content: value };
    }
    const report: ConfigReport = { surfaces };
    const hash = sha256Hex(canonicalJson(report));
    if (hash === lastHash) return;
    lastHash = hash;
    uploader.enqueue(report);
  };
}
