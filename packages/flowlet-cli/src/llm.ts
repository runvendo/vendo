/**
 * LLM plumbing for the CLI's assisted extractors.
 *
 * Uses generateText + zod-parse (NOT generateObject) so MockLanguageModelV3
 * can drive unit tests — same precedent as flowlet-agent's natural-language
 * policy judge.
 */
import { generateText, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";

/** Same default as demo-bank's DEMO_MODEL; override via FLOWLET_CLI_MODEL. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Returns null when no ANTHROPIC_API_KEY is present — callers skip LLM steps. */
export function cliModel(): LanguageModel | null {
  if (!process.env["ANTHROPIC_API_KEY"]) return null;
  return anthropic(process.env["FLOWLET_CLI_MODEL"] ?? DEFAULT_MODEL);
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
    // temperature 0: safety-relevant outputs (annotations, wrappers) must be as
    // run-to-run stable as the model allows.
    const { text } = await generateText({ model: opts.model, prompt, temperature: 0 });
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
