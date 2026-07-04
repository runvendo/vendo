/**
 * Provider-agnostic model resolution. Any one big-3 provider key alone selects
 * that provider and its default model; `FLOWLET_MODEL` overrides both — as
 * `provider/model` (pick a provider regardless of keys) or a bare id (applied
 * to the auto-detected provider, back-compatible with today's Anthropic-only
 * `FLOWLET_MODEL`). When several keys are set, precedence is Anthropic > OpenAI
 * > Google.
 *
 * `@ai-sdk/anthropic` is a regular dependency (statically imported). The OpenAI
 * and Google providers are optional peers, loaded via dynamic `import()` only
 * when actually resolved — a static import would crash installs that don't ship
 * them.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export type ModelProvider = "anthropic" | "openai" | "google";

/** The outcome of pure, SDK-free resolution — reused by capabilities and the CLI. */
export type ModelChoice =
  | { kind: "configured"; provider: ModelProvider; modelId: string }
  | { kind: "none" };

const DEFAULT_MODEL_ID: Record<ModelProvider, string> = {
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

/** The optional-peer package that supplies each non-Anthropic provider. */
const PROVIDER_PACKAGE: Record<Exclude<ModelProvider, "anthropic">, string> = {
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
};

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function detectProvider(env: Record<string, string | undefined>): ModelProvider | undefined {
  return PROVIDER_KEYS.find(([, key]) => present(env[key]))?.[0];
}

function isProvider(value: string): value is ModelProvider {
  return value === "anthropic" || value === "openai" || value === "google";
}

export function resolveModelChoice(
  env: Record<string, string | undefined> = process.env,
): ModelChoice {
  const detected = detectProvider(env);
  const flowletModel = env["FLOWLET_MODEL"]?.trim();

  if (flowletModel) {
    const slash = flowletModel.indexOf("/");
    if (slash !== -1) {
      const prefix = flowletModel.slice(0, slash);
      const rest = flowletModel.slice(slash + 1);
      if (!isProvider(prefix)) {
        throw new Error(
          `Flowlet: FLOWLET_MODEL="${flowletModel}" names an unknown provider "${prefix}" — supported providers are anthropic, openai, google (or pass a bare model id).`,
        );
      }
      return { kind: "configured", provider: prefix, modelId: rest || DEFAULT_MODEL_ID[prefix] };
    }
    // Bare id: apply to the detected provider; Anthropic is the back-compat default.
    return { kind: "configured", provider: detected ?? "anthropic", modelId: flowletModel };
  }

  if (detected) {
    return { kind: "configured", provider: detected, modelId: DEFAULT_MODEL_ID[detected] };
  }
  return { kind: "none" };
}

/** Injectable importer, defaulting to the real dynamic import (tests supply a fake). */
export interface ResolveModelDeps {
  import?: (spec: string) => Promise<unknown>;
}

async function loadOptionalProvider(
  importer: (spec: string) => Promise<unknown>,
  provider: Exclude<ModelProvider, "anthropic">,
  modelId: string,
): Promise<LanguageModel> {
  const pkg = PROVIDER_PACKAGE[provider];
  let mod: Record<string, unknown>;
  try {
    mod = (await importer(pkg)) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Flowlet: model "${provider}/${modelId}" requires ${pkg} — run: npm i ${pkg}`,
    );
  }
  const factory = mod[provider] as (id: string) => LanguageModel;
  return factory(modelId);
}

/**
 * Resolve the configured provider into a `LanguageModel`. The `none` state
 * falls back to constructing the Anthropic default (built without a key — it
 * only fails at call time, while chat stays gated by capabilities).
 */
export async function resolveModel(
  env: Record<string, string | undefined> = process.env,
  deps: ResolveModelDeps = {},
): Promise<LanguageModel> {
  const choice = resolveModelChoice(env);
  const provider = choice.kind === "configured" ? choice.provider : "anthropic";
  const modelId =
    choice.kind === "configured" ? choice.modelId : DEFAULT_MODEL_ID.anthropic;

  if (provider === "anthropic") {
    return anthropic(modelId);
  }
  const importer = deps.import ?? ((spec: string) => import(spec));
  return loadOptionalProvider(importer, provider, modelId);
}
