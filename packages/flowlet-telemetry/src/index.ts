import { homedir } from "node:os";
import { loadConfig, saveConfig } from "./config.js";
import { maybeShowNotice } from "./notice.js";
import { createTelemetry, DEFAULT_POSTHOG_KEY, type Telemetry } from "./client.js";

export { resolveConsent } from "./consent.js";
export { loadConfig, saveConfig, configPath, type TelemetryConfig } from "./config.js";
export { EVENT_ALLOWLIST, isAllowedProps, type EventName } from "./events.js";
export { createTelemetry, DEFAULT_POSTHOG_KEY, type Telemetry } from "./client.js";
export { maybeShowNotice } from "./notice.js";

export interface InitTelemetryOptions {
  version: string;
  env?: Record<string, string | undefined>;
  runtime?: boolean;
  posthogKey?: string;
  home?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Load config, show the first-run notice once, and return a ready client.
 * The CLI passes runtime:false; the dev server passes runtime:true.
 */
export function initTelemetry(opts: InitTelemetryOptions): Telemetry {
  const env = opts.env ?? process.env;
  const home = opts.home;
  const config = loadConfig(home);
  const afterNotice = maybeShowNotice(config, {
    log: opts.log ?? ((m) => console.error(m)),
    save: (c) => saveConfig(home ?? homedir(), c),
  });
  return createTelemetry({
    version: opts.version,
    config: afterNotice,
    env,
    runtime: opts.runtime ?? false,
    posthogKey: opts.posthogKey ?? env.FLOWLET_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY,
    fetchImpl: opts.fetchImpl,
  });
}
