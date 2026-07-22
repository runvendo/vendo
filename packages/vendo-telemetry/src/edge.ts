/** Web-standard-runtime entry (Cloudflare Workers, Bun workers, edge
 *  functions), selected by the package's `worker`/`workerd`/`edge-light`/
 *  `browser` export conditions. Telemetry's real client is Node-shaped through
 *  and through — disk-backed anonymous id under ~/.vendo, os/fs base props,
 *  node:crypto hashes — none of which exists on the edge, so the edge build
 *  is a no-op client rather than a porting exercise: deployments there simply
 *  don't report. Keep this module free of node builtins; the portability gate
 *  bundles it. */
import type { InitTelemetryOptions, Telemetry } from "./index.js";

export type { InitTelemetryOptions, Telemetry };

export function initTelemetry(_opts: InitTelemetryOptions): Telemetry {
  return { track: () => Promise.resolve() };
}
