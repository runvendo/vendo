import { initTelemetry, type Telemetry } from "@flowlet/telemetry";

export interface DevTelemetryOptions {
  env?: Record<string, string | undefined>;
  posthogKey?: string;
  home?: string;
  fetchImpl?: typeof fetch;
}

/** Telemetry for the running dev server. runtime:true means the resolver blocks production. */
export function devTelemetry(opts: DevTelemetryOptions = {}): Telemetry {
  const env = opts.env ?? process.env;
  return initTelemetry({
    version: "0.0.0",
    runtime: true,
    env,
    home: opts.home,
    posthogKey: opts.posthogKey ?? env.FLOWLET_POSTHOG_KEY,
    fetchImpl: opts.fetchImpl,
    log: () => {},
  });
}

export function errorClassName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : "Unknown";
}
