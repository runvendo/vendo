import { homedir } from "node:os";
import { loadConfig, saveConfig, type TelemetryConfig } from "./config.js";
import { createTelemetry, DEFAULT_POSTHOG_KEY, type Telemetry } from "./client.js";

export { envOptOut } from "./consent.js";
export { loadConfig, type TelemetryConfig } from "./config.js";
export { EVENT_ALLOWLIST, LOG_EVENTS, type EventName } from "./events.js";
export { type Telemetry } from "./client.js";
export { PROJECT_ID_SALT, repoHost, type RepoHost } from "./base-props.js";
export { scrubErrorDetail } from "./scrub.js";

const NOTICE = [
  "Vendo collects anonymous, opt-out usage telemetry to guide development.",
  "No code, prompts, file contents, or keys are ever collected.",
  "Details and opt-out: TELEMETRY.md; disable now: VENDO_TELEMETRY_DISABLED=1",
  "(also honored: DO_NOT_TRACK=1, CI)",
].join("\n");

interface NoticeIO {
  log: (msg: string) => void;
  save: (config: TelemetryConfig) => void;
}

function maybeShowNotice(config: TelemetryConfig, io: NoticeIO): TelemetryConfig {
  if (config.optedOut || config.noticeShown) return config;
  io.log(NOTICE);
  const updated = { ...config, noticeShown: true };
  io.save(updated);
  return updated;
}

export interface InitTelemetryOptions {
  version: string;
  env?: Record<string, string | undefined>;
  /** Project directory for projectIdHash lookup; defaults to process.cwd(). */
  cwd?: string;
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
  // Pass the same env used for consent so an env opt-out also suppresses the
  // fresh-config write (no tracking id minted for an opted-out user).
  const config = loadConfig(home, env);
  const afterNotice = maybeShowNotice(config, {
    log: opts.log ?? ((m) => console.error(m)),
    save: (c) => saveConfig(home ?? homedir(), c),
  });
  return createTelemetry({
    version: opts.version,
    config: afterNotice,
    env,
    cwd: opts.cwd,
    runtime: opts.runtime ?? false,
    posthogKey: opts.posthogKey ?? env.VENDO_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY,
    fetchImpl: opts.fetchImpl,
  });
}
