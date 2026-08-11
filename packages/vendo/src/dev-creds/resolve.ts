/**
 * The dev-mode model-credential resolver (install-dx v1, re-derived 2026-07-18).
 * Runtime model credentials are REAL KEYS ONLY — CLI-session rungs were removed
 * (a coding-agent login helps at init time only, never serves product turns).
 * Detection is PURE and read-only — no network, no writes, no key material in
 * the result (consumers read the env variable themselves).
 *
 * SELECTION LAW (2026-08-11): env keys are credentials, config selects. A
 * provider key lying around in the environment no longer selects a model —
 * `models: { default: … }` on createVendo does, and `VENDO_API_KEY` is the only
 * blessed default-filler for the slot a host left unset. Order:
 *
 *   1. VENDO_API_KEY (Vendo Cloud starter allowance / gateway)
 *   2. none (honest failure with exact instructions — NO_CREDENTIAL_MESSAGE)
 *
 * The `env-key` rung still EXISTS, and `ENV_KEY_VARS` is still its credential
 * table, but nothing arrives at it by accident: only the internal
 * `VENDO_DEV_CREDENTIAL` pin below can name it.
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
 *  (env-key:anthropic | vendo-cloud | none) pins the rung explicitly.
 *  INTERNAL ONLY — it is Vendo's own E2E rung matrix and escape hatch, not a
 *  documented host knob, and since the selection law it is the ONLY way to reach
 *  the `env-key` rung at all. Async for seam stability (callers and test seams
 *  predate the session-rung removal). */
export async function resolveDevCredential(
  options: ResolveDevCredentialOptions = {},
): Promise<DevCredential> {
  const env = options.env ?? process.env;

  const pinned = env["VENDO_DEV_CREDENTIAL"]?.trim();
  if (pinned !== undefined && pinned.length > 0) {
    if (pinned === "none") return { rung: "none" };
    // A pin that cannot resolve degrades, exactly like the env-key pin below:
    // without VENDO_API_KEY the cloud branch would call the Cloud gateway with
    // `apiKey: undefined`, and @ai-sdk/anthropic then falls back to
    // process.env.ANTHROPIC_API_KEY — sending the host's own provider key to a
    // third-party origin.
    if (pinned === "vendo-cloud") {
      return present(env, "VENDO_API_KEY") ? { rung: "vendo-cloud" } : { rung: "none" };
    }
    const match = /^env-key:(anthropic|openai|google)$/.exec(pinned);
    if (match !== null) {
      const provider = match[1] as EnvKeyProvider;
      const envVar = ENV_KEY_VARS.find((entry) => entry.provider === provider)!.envVar;
      return present(env, envVar) ? { rung: "env-key", provider, envVar } : { rung: "none" };
    }
  }

  // No provider-key sweep here, deliberately: a stray ANTHROPIC_API_KEY (or an
  // OPENAI / GOOGLE one) used to WIN this ladder, so a key left in a shell chose
  // the model — and the provider — for the host. Keys are credentials; the
  // `models` block on createVendo is what selects.
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
