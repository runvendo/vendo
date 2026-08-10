/**
 * The per-turn system prompt: base rules, the host's instructions, `[User]`
 * (session identity facts, server-trust), `[Situation]` (the stream's data
 * context — functions never serialize; they are the guard's, at check-time),
 * and the guard's directions. Assembled per turn because it needs the ctx a
 * `Turn` deliberately does not carry; it rides `Turn.system`.
 */
import { situationPromptBlock, todayPromptBlock, userPromptBlock, type Json, type RunContext } from "@vendoai/core";

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
  /** `guard.directions(ctx)`, resolved by the caller. */
  directions?: readonly string[];
}

/** The host's last word on a turn's system prompt, in either venue — see
 *  `AgentConfig.system` for the contract. */
export type SystemPromptHook = (
  ctx: RunContext,
  prompt: { assembled: string; directions: readonly string[] },
) => string | undefined | Promise<string | undefined>;

export function assemblePrompt(input: PromptInput): string {
  const sections: string[] = [BASE_RULES];
  if (input.instructions !== undefined && input.instructions.trim() !== "") {
    sections.push(input.instructions.trim());
  }
  // All three blocks — the labels, the observation note, and the
  // section-forgery indent that stops a client-supplied fact from forging a
  // top-level `Directions` — are core's, shared verbatim with the umbrella's
  // assembler. `[Today]` is here for the same reason the other two are: this is
  // the whole system prompt for a host that adopted `agent()` without a
  // `system` hook, and an agent that does not know the date asks the user for
  // it. The umbrella threads a clock in for its own tests; nothing here needs
  // to, so this takes core's default.
  sections.push(todayPromptBlock());
  const user = userPromptBlock(input.user);
  if (user !== undefined) sections.push(user);
  const situation = situationPromptBlock(input.situation);
  if (situation !== undefined) sections.push(situation);
  const directions = (input.directions ?? []).map((d) => d.trim()).filter((d) => d !== "");
  if (directions.length > 0) {
    sections.push(["Directions", ...directions.map((d) => `- ${d}`)].join("\n"));
  }
  return sections.join("\n\n");
}
