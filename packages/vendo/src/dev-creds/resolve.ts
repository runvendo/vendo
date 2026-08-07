/**
 * The dev-mode model-credential resolver (install-dx v1, re-derived 2026-07-18).
 * Runtime model credentials are REAL KEYS ONLY — CLI-session rungs were removed
 * (a coding-agent login helps at init time only, never serves product turns).
 * Detection is PURE and read-only — no network, no writes, no key material in
 * the result (consumers read the env variable themselves). Order (explicit
 * beats implicit):
 *
 *   1. explicit env key (ANTHROPIC / OPENAI / GOOGLE)
 *   2. VENDO_API_KEY (Vendo Cloud starter allowance / gateway)
 *   3. none (honest failure with exact instructions)
 */

export type EnvKeyProvider = "anthropic" | "openai" | "google";

export type DevCredential =
  | { rung: "env-key"; provider: EnvKeyProvider; envVar: string }
  | { rung: "vendo-cloud" }
  | { rung: "none" };

export const ENV_KEY_VARS: ReadonlyArray<{ envVar: string; provider: EnvKeyProvider }> = [
  { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
  { envVar: "OPENAI_API_KEY", provider: "openai" },
  { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", provider: "google" },
];

export interface ResolveDevCredentialOptions {
  env?: Record<string, string | undefined>;
}

function present(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/** Detect the best available model credential. `VENDO_DEV_CREDENTIAL`
 *  (env-key:anthropic | vendo-cloud | none) pins the rung explicitly — used by
 *  E2E rung matrices and escape hatches. Async for seam stability (callers and
 *  test seams predate the session-rung removal). */
export async function resolveDevCredential(
  options: ResolveDevCredentialOptions = {},
): Promise<DevCredential> {
  const env = options.env ?? process.env;

  const pinned = env["VENDO_DEV_CREDENTIAL"]?.trim();
  if (pinned !== undefined && pinned.length > 0) {
    if (pinned === "vendo-cloud" || pinned === "none") return { rung: pinned };
    const match = /^env-key:(anthropic|openai|google)$/.exec(pinned);
    if (match !== null) {
      const provider = match[1] as EnvKeyProvider;
      const envVar = ENV_KEY_VARS.find((entry) => entry.provider === provider)!.envVar;
      return present(env, envVar) ? { rung: "env-key", provider, envVar } : { rung: "none" };
    }
  }

  for (const { envVar, provider } of ENV_KEY_VARS) {
    if (present(env, envVar)) return { rung: "env-key", provider, envVar };
  }

  if (present(env, "VENDO_API_KEY")) return { rung: "vendo-cloud" };
  return { rung: "none" };
}

/** One human line for the wizard / doctor / runtime log. */
export function describeDevCredential(credential: DevCredential): string {
  switch (credential.rung) {
    case "env-key":
      return `explicit ${credential.envVar} (${credential.provider})`;
    case "vendo-cloud":
      return "VENDO_API_KEY (Vendo Cloud)";
    case "none":
      return "no model credential found";
  }
}
