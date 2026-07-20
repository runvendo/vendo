export interface ConsentInputs {
  env: Record<string, string | undefined>;
  /** true if the config file records an explicit opt-out */
  optedOut: boolean;
  /** true for callers inside the running app (dev server); false for the CLI */
  runtime: boolean;
}

export interface ConsentResult {
  allowed: boolean;
  reason: string;
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

function envOptOutReason(
  env: Record<string, string | undefined>,
): "env-disabled" | "do-not-track" | "ci" | undefined {
  if (truthy(env.VENDO_TELEMETRY_DISABLED)) return "env-disabled";
  if (truthy(env.DO_NOT_TRACK)) return "do-not-track";
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false") return "ci";
  return undefined;
}

/**
 * True when an environment opt-out is in effect (VENDO_TELEMETRY_DISABLED,
 * DO_NOT_TRACK, or CI). Used both by resolveConsent (to gate track()) and by
 * loadConfig (to avoid minting/persisting a tracking id the user opted out of).
 */
export function envOptOut(env: Record<string, string | undefined>): boolean {
  return envOptOutReason(env) !== undefined;
}

export function resolveConsent({ env, optedOut, runtime }: ConsentInputs): ConsentResult {
  const envReason = envOptOutReason(env);
  if (envReason !== undefined) return { allowed: false, reason: envReason };
  if (optedOut) return { allowed: false, reason: "config-opt-out" };
  // Runtime (dev-server) collection is allowed ONLY when NODE_ENV explicitly
  // names a dev environment. An unset/unknown NODE_ENV is treated as production
  // (fail closed) so a prod deploy that forgot to set it is never collected
  // from. Build-side callers (runtime:false) are unaffected.
  if (runtime && env.NODE_ENV !== "development" && env.NODE_ENV !== "test")
    return { allowed: false, reason: "production" };
  return { allowed: true, reason: "allowed" };
}
