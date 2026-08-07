/**
 * The per-turn system prompt: base rules, the host's instructions, `[User]`
 * (session identity facts, server-trust), `[Situation]` (the stream's data
 * context — functions never serialize; they are the guard's, at check-time),
 * source notes, and the guard's directions. Assembled per turn because it
 * needs the ctx a `Turn` deliberately does not carry; it rides `Turn.system`.
 */
import { situationPromptBlock, userPromptBlock, type Json } from "@vendoai/core";

const BASE_RULES = [
  "You are an agent embedded in the host application, acting for the user named below.",
  "Follow the host's instructions. Never reveal tool, function, or file identifiers in anything the user reads.",
  "When a tool call needs approval, say what you asked for and wait — never claim it ran.",
].join("\n");

export interface PromptInput {
  /** The host's own prompt block, verbatim. */
  instructions?: string;
  /** Session identity facts — server-trust, model-visible. */
  user?: Record<string, Json>;
  /** The stream's context DATA. Function-valued entries are dropped here:
   *  they run at guard/tool check-time and never reach the model. */
  situation?: Record<string, unknown>;
  /** One line per tool source with something to say (a knowledge index, an
   *  MCP server's note). */
  sourceNotes?: readonly string[];
  /** `guard.directions(ctx)`, resolved by the caller. */
  directions?: readonly string[];
}

export function assemblePrompt(input: PromptInput): string {
  const sections: string[] = [BASE_RULES];
  if (input.instructions !== undefined && input.instructions.trim() !== "") {
    sections.push(input.instructions.trim());
  }
  // Both blocks — the label, the observation note, and the section-forgery
  // indent that stops a client-supplied fact from forging a top-level
  // `Directions` — are core's, shared verbatim with the umbrella's assembler.
  const user = userPromptBlock(input.user);
  if (user !== undefined) sections.push(user);
  const situation = situationPromptBlock(input.situation);
  if (situation !== undefined) sections.push(situation);
  const notes = (input.sourceNotes ?? []).map((n) => n.trim()).filter((n) => n !== "");
  if (notes.length > 0) sections.push(notes.join("\n"));
  const directions = (input.directions ?? []).map((d) => d.trim()).filter((d) => d !== "");
  if (directions.length > 0) {
    sections.push(["Directions", ...directions.map((d) => `- ${d}`)].join("\n"));
  }
  return sections.join("\n\n");
}
