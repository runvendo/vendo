/**
 * Provider-agnostic model resolution. Any one big-3 provider key alone selects
 * that provider and its default model; `VENDO_MODEL` overrides both — as
 * `provider/model` (pick a provider regardless of keys) or a bare id (applied
 * to the auto-detected provider, back-compatible with today's Anthropic-only
 * `VENDO_MODEL`). When several keys are set, precedence is Anthropic > OpenAI
 * > Google.
 *
 * `@ai-sdk/anthropic` is a regular dependency (statically imported). The OpenAI
 * and Google providers are optional peers, loaded via dynamic `import()` only
 * when actually resolved — a static import would crash installs that don't ship
 * them.
 *
 * Also published as the `@vendoai/server/model` subpath (see package.json) —
 * a lean import for consumers like `@vendoai/cli` that only need model
 * resolution and must NOT drag in the rest of `@vendoai/server`'s barrel
 * (chat/action/world/... transitively pull `@vendoai/runtime`, whose deps
 * like `jsonata`/`croner` aren't declared in every consumer's package.json —
 * importing the bare package name lets a bundler's tree-shaking fail to prove
 * those barrel modules are side-effect-free and inline them anyway).
 */
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import {
  DEFAULT_MODEL_ID,
  hasProviderKey,
  resolveModelChoice,
  type ModelChoice,
  type ModelProvider,
} from "./model-choice.js";

// Re-exported so the package's public API (`@vendoai/server`'s index.ts)
// stays unchanged — the pure resolution logic itself now lives in
// `./model-choice`, which `capabilities.ts` also imports without pulling in
// `@ai-sdk/anthropic`. `hasProviderKey` is re-exported for consumers (like
// `@vendoai/cli`) that must gate on credential presence: a VENDO_MODEL id
// alone is not a credential.
export { hasProviderKey, resolveModelChoice };
export type { ModelChoice, ModelProvider };

/** The optional-peer package that supplies each non-Anthropic provider. */
const PROVIDER_PACKAGE: Record<Exclude<ModelProvider, "anthropic">, string> = {
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
};

/** Injectable importer, defaulting to the real dynamic import (tests supply a fake). */
export interface ResolveModelDeps {
  import?: (spec: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

/**
 * A configured provider's optional peer (@ai-sdk/openai, @ai-sdk/google)
 * could not be loaded. Unlike a misconfigured VENDO_MODEL (which must fail
 * loudly), this state is part of the documented capability ladder and the
 * handler degrades it to chat:false + an actionable hint.
 */
export class ModelPeerMissingError extends Error {
  override readonly name = "ModelPeerMissingError";
}

async function loadOptionalProvider(
  importer: (spec: string) => Promise<unknown>,
  provider: Exclude<ModelProvider, "anthropic">,
  modelId: string,
): Promise<LanguageModel> {
  const pkg = PROVIDER_PACKAGE[provider];
  const missingPeerError = new ModelPeerMissingError(
    `Vendo: model "${provider}/${modelId}" requires ${pkg} — run: npm i ${pkg}`,
  );
  let mod: Record<string, unknown>;
  try {
    mod = (await importer(pkg)) as Record<string, unknown>;
  } catch {
    throw missingPeerError;
  }
  const factory = mod[provider];
  if (typeof factory !== "function") {
    // The module resolved but doesn't export the expected provider factory
    // (stale/incompatible version, broken mock) — surface the same
    // actionable error instead of a cryptic "factory is not a function".
    throw missingPeerError;
  }
  return (factory as (id: string) => LanguageModel)(modelId);
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
    const providerFactory = deps.fetch ? createAnthropic({ fetch: deps.fetch as never }) : anthropic;
    return providerFactory(modelId);
  }
  const importer = deps.import ?? ((spec: string) => import(spec));
  return loadOptionalProvider(importer, provider, modelId);
}
