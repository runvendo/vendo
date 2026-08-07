/** Web-standard-runtime entry (Cloudflare Workers, Bun workers, edge
 *  functions), selected by the package's `worker`/`workerd`/`edge-light`/
 *  `browser` export conditions. Telemetry's real client is Node-shaped through
 *  and through — disk-backed anonymous id under ~/.vendo, os/fs base props,
 *  node:crypto hashes — none of which exists on the edge, so the edge build
 *  is a no-op client rather than a porting exercise: deployments there simply
 *  don't report. Keep this module free of node builtins; the portability gate
 *  bundles it. */
import type { RepoHost } from "./base-props.js";
import type { TelemetryConfig } from "./config.js";
import type { InitTelemetryOptions, Telemetry } from "./index.js";

export type { InitTelemetryOptions, RepoHost, Telemetry, TelemetryConfig };

// Pure module (no imports at all) — shared with the Node build.
export { envOptOut, resolveConsent } from "./consent.js";

export function initTelemetry(_opts: InitTelemetryOptions): Telemetry {
  return { track: () => Promise.resolve() };
}

/** No disk on the edge: every deployment reads as opted out, nothing persists. */
export function loadConfig(_home?: string, _env?: Record<string, string | undefined>): TelemetryConfig {
  return { anonymousId: "", optedOut: true, noticeShown: true };
}

export function saveConfig(_home: string, _config: TelemetryConfig): void {
  // No disk on the edge; opt-out state is implicit (loadConfig above).
}

/** Git remotes are a working-copy concept; deployed edge bundles have none. */
export function repoHost(_cwd?: string): RepoHost | undefined {
  return undefined;
}
