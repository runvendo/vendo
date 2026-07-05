/**
 * Pure, SDK-free provider selection — no runtime imports, so `capabilities.ts`
 * (a client-safe subpath export enforced by client-safe-guard.test.ts) can use
 * it without pulling in `@ai-sdk/anthropic` or any other server-only package.
 *
 * `model.ts` re-exports `resolveModelChoice`/`ModelChoice`/`ModelProvider`
 * from here so the package's public API is unchanged, and wraps this with the
 * actual `LanguageModel` construction.
 *
 * This module also hosts the generic `present()` env helper reused by
 * `capabilities.ts` — it must live in a runtime-import-free module so the
 * client-safe subpath chain stays pure.
 */

export type ModelProvider = "anthropic" | "openai" | "google";

/** The outcome of pure, SDK-free resolution — reused by capabilities and the CLI. */
export type ModelChoice =
  | { kind: "configured"; provider: ModelProvider; modelId: string }
  | { kind: "none" };

export const DEFAULT_MODEL_ID: Record<ModelProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.5",
  google: "gemini-3.5-flash",
};

/** Env var per provider, in precedence order (first present wins). */
const PROVIDER_KEYS: ReadonlyArray<readonly [ModelProvider, string]> = [
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["google", "GOOGLE_GENERATIVE_AI_API_KEY"],
];

export function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function detectProvider(env: Record<string, string | undefined>): ModelProvider | undefined {
  return PROVIDER_KEYS.find(([, key]) => present(env[key]))?.[0];
}

/** True when any of the big-3 provider keys is present — the chat gate. */
export function hasProviderKey(env: Record<string, string | undefined>): boolean {
  return detectProvider(env) !== undefined;
}

function isProvider(value: string): value is ModelProvider {
  return value === "anthropic" || value === "openai" || value === "google";
}

export function resolveModelChoice(
  env: Record<string, string | undefined> = process.env,
): ModelChoice {
  const detected = detectProvider(env);
  const vendoModel = env["VENDO_MODEL"]?.trim();

  if (vendoModel) {
    const slash = vendoModel.indexOf("/");
    if (slash !== -1) {
      const prefix = vendoModel.slice(0, slash);
      const rest = vendoModel.slice(slash + 1);
      if (!isProvider(prefix)) {
        throw new Error(
          `Vendo: VENDO_MODEL="${vendoModel}" names an unknown provider "${prefix}" — supported providers are anthropic, openai, google (or pass a bare model id).`,
        );
      }
      return { kind: "configured", provider: prefix, modelId: rest || DEFAULT_MODEL_ID[prefix] };
    }
    // Bare id: apply to the detected provider; Anthropic is the back-compat default.
    return { kind: "configured", provider: detected ?? "anthropic", modelId: vendoModel };
  }

  if (detected) {
    return { kind: "configured", provider: detected, modelId: DEFAULT_MODEL_ID[detected] };
  }
  return { kind: "none" };
}
