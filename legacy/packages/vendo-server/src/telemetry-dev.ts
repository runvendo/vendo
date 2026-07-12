import { initTelemetry, type Telemetry } from "@vendoai/telemetry";

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
    posthogKey: opts.posthogKey ?? env.VENDO_POSTHOG_KEY,
    fetchImpl: opts.fetchImpl,
    // No log override: let initTelemetry emit the one-time disclosure to a real
    // sink (console.error). A no-op sink here marked the notice "shown" while
    // showing nothing, so collection proceeded without ever disclosing it.
  });
}

export function errorClassName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : "Unknown";
}
