/**
 * Provider API-key handling for `vendo init`'s key-prompt step: detect which
 * provider a pasted key belongs to from its shape, validate it with a real
 * one-token generate call (fully injectable — no test ever touches the
 * network), and append it to `.env.local` without disturbing existing
 * content. This module never logs or echoes the raw key.
 *
 * Mirrors `@vendoai/server`'s model.ts loading precedent (see llm.ts's header
 * comment): `@ai-sdk/anthropic` is a regular dependency, statically imported;
 * `@ai-sdk/openai`/`@ai-sdk/google` are optional peers loaded via dynamic
 * `import()` only when actually needed. An unresolvable optional peer here is
 * reported as its own `"unavailable"` outcome — distinct from an actual
 * bad-key `"invalid"` failure — since the fix is "install the package", not
 * "paste a different key".
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModel } from "ai";
import { resolveModelChoice, type ModelProvider } from "@vendoai/server/model";

export type { ModelProvider };

/**
 * Env var per provider — the one place these three strings live for the
 * key-prompt path. (`llm.ts`'s `cliModel`/`resolveModel` read the same three
 * names independently, straight off real `process.env`, for normal command
 * runs — this map exists so `detectProvider`'s result and `appendProviderKey`
 * always agree on the name without restating the strings.)
 */
export const PROVIDER_ENV_VAR: Record<ModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/** The optional-peer package + its provider-factory export, per non-Anthropic
 *  provider (mirrors `model.ts`'s private `PROVIDER_PACKAGE` table). */
const OPTIONAL_PROVIDER: Record<Exclude<ModelProvider, "anthropic">, { pkg: string; createExport: string }> = {
  openai: { pkg: "@ai-sdk/openai", createExport: "createOpenAI" },
  google: { pkg: "@ai-sdk/google", createExport: "createGoogleGenerativeAI" },
};

/**
 * Detects which provider a pasted key belongs to from its shape alone — no
 * network call, see `validateKey` for that. `null` for anything unrecognized.
 *
 * Order matters: Anthropic keys (`sk-ant-...`) also start with `sk-`, so that
 * check must run before the generic OpenAI `sk-` check (which also matches
 * `sk-proj-...`).
 */
export function detectProvider(key: string): ModelProvider | null {
  const trimmed = key.trim();
  if (trimmed.startsWith("sk-ant-")) return "anthropic";
  if (trimmed.startsWith("AIza")) return "google";
  if (trimmed.startsWith("sk-")) return "openai";
  return null;
}

export type KeyValidation =
  | { status: "valid" }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string };

export interface ValidateKeyDeps {
  /** Injectable dynamic importer for the optional OpenAI/Google peers. Defaults to real `import()`. */
  import?: (spec: string) => Promise<unknown>;
  /** Injectable model override — tests supply this to skip real provider
   *  construction (and the network) entirely, for any provider. */
  model?: LanguageModel;
}

/** Resolves this provider's default model id without duplicating the
 *  provider→default-model-id map: delegates to `resolveModelChoice` with only
 *  this one env var set, so it detects exactly this provider. */
function defaultModelId(provider: ModelProvider, key: string): string {
  const choice = resolveModelChoice({ [PROVIDER_ENV_VAR[provider]]: key });
  /* istanbul ignore next -- always "configured": the env var we just set is exactly what resolveModelChoice looks for. */
  return choice.kind === "configured" ? choice.modelId : "";
}

async function buildModel(
  provider: ModelProvider,
  key: string,
  importer: (spec: string) => Promise<unknown>,
): Promise<{ model: LanguageModel } | { unavailable: string }> {
  const modelId = defaultModelId(provider, key);
  if (provider === "anthropic") {
    return { model: createAnthropic({ apiKey: key })(modelId) };
  }
  const { pkg, createExport } = OPTIONAL_PROVIDER[provider];
  let mod: Record<string, unknown>;
  try {
    mod = (await importer(pkg)) as Record<string, unknown>;
  } catch {
    return { unavailable: `install ${pkg}` };
  }
  const creator = mod[createExport];
  if (typeof creator !== "function") {
    // Resolved, but not the expected export (stale/incompatible version,
    // broken test double) — same actionable outcome as a missing package.
    return { unavailable: `install ${pkg}` };
  }
  const factory = (creator as (settings: { apiKey: string }) => (id: string) => LanguageModel)({ apiKey: key });
  return { model: factory(modelId) };
}

/**
 * Validates a candidate key with a real one-token generate call — the only
 * way to actually know a pasted key works. Fully injectable via `deps.model`
 * (bypasses provider construction and the network for every provider) or
 * `deps.import` (to simulate a missing optional peer).
 */
export async function validateKey(
  provider: ModelProvider,
  key: string,
  deps: ValidateKeyDeps = {},
): Promise<KeyValidation> {
  let model: LanguageModel;
  if (deps.model) {
    model = deps.model;
  } else {
    const importer = deps.import ?? ((spec: string) => import(spec));
    const built = await buildModel(provider, key, importer);
    if ("unavailable" in built) return { status: "unavailable", reason: built.unavailable };
    model = built.model;
  }

  try {
    await generateText({ model, prompt: "Reply with one word.", maxOutputTokens: 1 });
    return { status: "valid" };
  } catch (err) {
    return { status: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface AppendKeyResult {
  /** Absolute path to `.env.local`. */
  file: string;
  /** Whether the file was created (`false` when it already existed). */
  created: boolean;
}

/**
 * Appends `PROVIDER_KEY=...` to `.env.local` under a `# added by vendo init`
 * comment, preserving existing content byte-for-byte, and creates the file if
 * absent. Never logs the key — that's the caller's call to make (and it
 * shouldn't).
 */
export async function appendProviderKey(
  targetDir: string,
  provider: ModelProvider,
  key: string,
): Promise<AppendKeyResult> {
  const file = path.join(targetDir, ".env.local");
  let existing: string | null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    existing = null;
  }
  const created = existing === null;
  const base = existing ?? "";
  // Normalize to exactly one trailing newline before appending, so the
  // boundary reads the same whether or not the file previously ended cleanly.
  const normalized = base.length > 0 && !base.endsWith("\n") ? `${base}\n` : base;
  const block = `\n# added by vendo init\n${PROVIDER_ENV_VAR[provider]}=${key}\n`;
  await fs.writeFile(file, `${normalized}${block}`);
  return { file, created };
}
