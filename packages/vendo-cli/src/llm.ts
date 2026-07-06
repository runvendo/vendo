/**
 * LLM plumbing for the CLI's assisted extractors.
 *
 * Uses generateText + zod-parse (NOT generateObject) so MockLanguageModelV3
 * can drive unit tests — same precedent as vendo-runtime's natural-language
 * policy judge.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
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

/**
 * The env vars `cliModel` consults — the three provider keys plus the two model
 * overrides. Only these are lifted out of `.env.local`; nothing else in that
 * file is read into the model-resolution env view.
 */
const CLI_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "VENDO_CLI_MODEL",
  "VENDO_MODEL",
] as const;

/**
 * Minimal `.env` parser (no `dotenv` dependency exists in the workspace, and a
 * full one is overkill here). Handles the dotenv basics: `KEY=value` lines,
 * with `#` comments and blank lines ignored, an optional `export ` prefix
 * dropped, and one layer of surrounding single/double quotes stripped. No
 * interpolation or multiline values — those never appear in a provider key.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * The env `cliModel` should see for a run rooted at `targetDir`: the
 * Vendo-relevant vars from `<targetDir>/.env.local`, overlaid by real
 * `process.env` (real env wins — the dotenv / Next.js convention). Restricted
 * to {@link CLI_ENV_KEYS} so nothing else in `.env.local` leaks into model
 * resolution. Absent/unreadable `.env.local` → just the `base` values.
 */
export async function cliEnvForDir(
  targetDir: string,
  base: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(await fs.readFile(path.join(targetDir, ".env.local"), "utf8"));
  } catch {
    // No .env.local (or unreadable) — fall back to base env alone.
  }
  const merged: Record<string, string | undefined> = {};
  for (const key of CLI_ENV_KEYS) {
    merged[key] = base[key] ?? fromFile[key];
  }
  return merged;
}

/**
 * Like {@link cliModel}, but reads `<targetDir>/.env.local` in addition to real
 * `process.env` first. This is how `vendo init` picks up a key a developer
 * added to `.env.local` by hand (or that its own key-prompt step just wrote)
 * without requiring it to also be exported into the shell.
 */
export async function resolveCliModel(
  targetDir: string,
  deps?: ResolveModelDeps,
  base: Record<string, string | undefined> = process.env,
): Promise<LanguageModel | null> {
  return cliModel(await cliEnvForDir(targetDir, base), deps);
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
