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

export function resolveConsent({ env, optedOut, runtime }: ConsentInputs): ConsentResult {
  if (truthy(env.FLOWLET_TELEMETRY_DISABLED)) return { allowed: false, reason: "env-disabled" };
  if (truthy(env.DO_NOT_TRACK)) return { allowed: false, reason: "do-not-track" };
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false")
    return { allowed: false, reason: "ci" };
  if (optedOut) return { allowed: false, reason: "config-opt-out" };
  if (runtime && env.NODE_ENV === "production") return { allowed: false, reason: "production" };
  return { allowed: true, reason: "allowed" };
}
