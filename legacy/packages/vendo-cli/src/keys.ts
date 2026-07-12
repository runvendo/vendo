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
import { APICallError, RetryError, generateText, type LanguageModel } from "ai";
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
  /** The one-token call succeeded — the key works. */
  | { status: "valid" }
  /** The provider rejected the credential itself (HTTP 401/403) — the user
   *  should paste a different key. */
  | { status: "invalid"; reason: string }
  /** The optional provider package isn't installed — the fix is
   *  `npm i @ai-sdk/...`, not a different key. */
  | { status: "unavailable"; reason: string }
  /** The call failed for reasons that say nothing about the key: timeout,
   *  offline, 429/5xx, DNS. Retry later; do NOT tell the user the key is bad. */
  | { status: "unreachable"; reason: string };

export interface ValidateKeyDeps {
  /** Injectable dynamic importer for the optional OpenAI/Google peers. Defaults to real `import()`. */
  import?: (spec: string) => Promise<unknown>;
  /** Injectable model override — tests supply this to skip real provider
   *  construction (and the network) entirely, for any provider. */
  model?: LanguageModel;
  /** Abort the validation call after this many ms (default 10s), failing into
   *  `"unreachable"`. Tests shrink it to keep the timeout path fast. */
  timeoutMs?: number;
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

/** Human name per provider, for user-facing "could not reach ..." reasons. */
const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

const DEFAULT_VALIDATE_TIMEOUT_MS = 10_000;

/**
 * Splits a failed validation call into "the key is bad" (the provider itself
 * rejected the credential: 401/403) vs "the call never meaningfully reached a
 * verdict" (timeout, offline, DNS, 429, 5xx → `"unreachable"`). Only an
 * `APICallError` carries a status code; `generateText`'s retry loop wraps the
 * final error in a `RetryError`, so unwrap that first.
 */
function classifyFailure(provider: ModelProvider, err: unknown): KeyValidation {
  const inner = RetryError.isInstance(err) ? err.lastError : err;
  if (APICallError.isInstance(inner) && (inner.statusCode === 401 || inner.statusCode === 403)) {
    return { status: "invalid", reason: inner.message };
  }
  const detail = inner instanceof Error ? inner.message : String(inner);
  return {
    status: "unreachable",
    reason: `could not reach ${PROVIDER_LABEL[provider]} (${detail}); check your connection and retry`,
  };
}

/**
 * Validates a candidate key with a real one-token generate call — the only
 * way to actually know a pasted key works. Fully injectable via `deps.model`
 * (bypasses provider construction and the network for every provider),
 * `deps.import` (to simulate a missing optional peer), and `deps.timeoutMs`
 * (the abort timeout on the call, default 10s).
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
    await generateText({
      model,
      prompt: "Reply with one word.",
      maxOutputTokens: 1,
      // Fail fast: no backoff-retries on 429/5xx — a validation ping's
      // "unreachable" outcome already tells the user to retry.
      maxRetries: 0,
      timeout: deps.timeoutMs ?? DEFAULT_VALIDATE_TIMEOUT_MS,
    });
    return { status: "valid" };
  } catch (err) {
    return classifyFailure(provider, err);
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
 * absent (owner-only 0600, since it holds a credential; an existing file
 * keeps whatever permissions the user gave it — we only append). Append-only:
 * checking whether the var is already set (and deciding what a duplicate
 * means — dotenv's last-wins applies) is the caller's responsibility. Never
 * logs the key — that's the caller's call to make (and it shouldn't).
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
  // mode applies on CREATION only — an existing .env.local keeps its perms.
  await fs.writeFile(file, `${normalized}${block}`, { mode: 0o600 });
  return { file, created };
}
