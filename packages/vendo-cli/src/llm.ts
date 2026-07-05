/**
 * LLM plumbing for the CLI's assisted extractors.
 *
 * Uses generateText + zod-parse (NOT generateObject) so MockLanguageModelV3
 * can drive unit tests — same precedent as vendo-runtime's natural-language
 * policy judge.
 */
import { generateText, type LanguageModel } from "ai";
// Imported via the lean `/model` subpath, NOT the bare `@vendoai/server`
// package — the barrel pulls in `@vendoai/runtime` (jsonata, croner, ...)
// transitively, which a bundler can't tree-shake away when re-exports aren't
// provably side-effect-free (see model.ts's header comment).
import { hasProviderKey, resolveModel, type ResolveModelDeps } from "@vendoai/server/model";
import type { z } from "zod";

/**
 * Resolves the CLI's LLM from any of the three provider keys (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY — same precedence as the runtime:
 * Anthropic > OpenAI > Google), via `@vendoai/server`'s `resolveModel`.
 *
 * `VENDO_CLI_MODEL` is the CLI-specific override, taking precedence over the
 * shared `VENDO_MODEL` — both accept `provider/model` or a bare model id
 * (applied to the detected provider). Implemented by aliasing
 * VENDO_CLI_MODEL onto VENDO_MODEL before delegating, so it reuses
 * `resolveModelChoice`'s parsing exactly.
 *
 * Gated on key presence: a VENDO_MODEL/VENDO_CLI_MODEL id alone is NOT a
 * credential (same principle as the runtime's chat capability), so with zero
 * provider keys this returns null — callers skip LLM steps and fall back to
 * deterministic rescues — instead of constructing an unkeyed model that would
 * fail mid-init with a raw SDK "API key is missing" error. Only when a key IS
 * present can this throw, in two cases (both intentional — the user
 * explicitly configured something broken and deserves the error over a
 * silent deterministic fallback):
 *   - the override names an unknown provider prefix (e.g. "grok/whatever"):
 *     `resolveModelChoice` (inside `resolveModel`) throws its readable error;
 *   - the resolved provider's optional peer package
 *     (@ai-sdk/openai/@ai-sdk/google) isn't installed: `resolveModel` throws
 *     its actionable install-command error.
 */
export async function cliModel(
  env: Record<string, string | undefined> = process.env,
  deps?: ResolveModelDeps,
): Promise<LanguageModel | null> {
  const cliOverride = env["VENDO_CLI_MODEL"]?.trim();
  const resolvedEnv = cliOverride ? { ...env, VENDO_MODEL: cliOverride } : env;
  if (!hasProviderKey(resolvedEnv)) return null;
  return resolveModel(resolvedEnv, deps);
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json|typescript|tsx)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? text).trim();
}

export async function generateJson<T>(opts: {
  model: LanguageModel;
  /** Output-typed: schemas with .default() fields infer their parsed shape. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  prompt: string;
}): Promise<T> {
  const ask = async (prompt: string): Promise<{ value?: T; error: string }> => {
    // No explicit temperature: the current-generation default models
    // (claude-sonnet-5, opus-4.8/4.7, gpt-5.x, gemini-3.x) REJECT the
    // `temperature` parameter with a 400 ("temperature is deprecated for this
    // model") — they fix sampling internally. Passing temperature:0 here made
    // every LLM-assisted extraction (component wrappers) fail on a fresh
    // install with the default provider model. Omitting it is valid on every
    // model; the parse-retry below covers the small determinism loss on the
    // older models that still honor a default temperature.
    const { text } = await generateText({ model: opts.model, prompt });
    try {
      return { value: opts.schema.parse(JSON.parse(stripFences(text))), error: "" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const first = await ask(opts.prompt);
  if (first.value !== undefined) return first.value;
  const second = await ask(
    `${opts.prompt}\n\nYour previous response failed to parse: ${first.error}\nRespond with ONLY valid JSON matching the requested shape.`,
  );
  if (second.value !== undefined) return second.value;
  throw new Error(`LLM output failed validation after retry: ${second.error}`);
}
