/**
 * The per-turn system prompt: base rules, the host's instructions, `[User]`
 * (session identity facts, server-trust), `[Memory]` (what this person asked to
 * be remembered), `[Situation]` (the stream's data context — functions never
 * serialize; they are the guard's, at check-time), and the guard's directions.
 * Assembled per turn because it needs the ctx a `Turn` deliberately does not
 * carry; it rides `Turn.system`.
 */
import {
  memoryPromptBlock,
  situationPromptBlock,
  userPromptBlock,
  type Guard,
  type Json,
  type RunContext,
} from "@vendoai/core";
import { MEMORY_RECALL_LIMIT, MEMORY_TEXT_MAX_CHARS, type MemoryAdapter } from "./memory.js";

/** Who the agent is acting for. An unattended run often has no user at all, and
 *  "the user named below" with nobody below it is a dangling reference. */
const role = (named: boolean): string =>
  `You are an agent embedded in the host application${named ? ", acting for the user named below" : ""}.`;

const BASE_RULES = [
  "Follow the host's instructions. Never reveal tool, function, or file identifiers in anything the user reads.",
  "When a tool call needs approval, say what you asked for and wait — never claim it ran.",
].join("\n");

export interface PromptInput {
  /** The host's own prompt block, verbatim. */
  instructions?: string;
  /** Session identity facts — server-trust, model-visible. */
  user?: Record<string, Json>;
  /** This user's remembered facts, oldest first — DATA the model reads, never
   *  instruction. Pass as many as you have: the cap is applied HERE, so a BYO
   *  `MemoryAdapter` that ignores its `limit` still gets a bounded block. */
  memories?: readonly string[];
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
  // Both blocks — the label, the observation note, and the section-forgery
  // indent that stops a client-supplied fact from forging a top-level
  // `Directions` — are core's, shared verbatim with the umbrella's assembler.
  const user = userPromptBlock(input.user);
  const sections: string[] = [`${role(user !== undefined)}\n${BASE_RULES}`];
  if (input.instructions !== undefined && input.instructions.trim() !== "") {
    sections.push(input.instructions.trim());
  }
  if (user !== undefined) sections.push(user);
  // Beside `[User]` and before `[Situation]`: who they are, then what they asked
  // to be remembered about themselves, then what is on their screen now — and
  // the guard's directions after all three, where nothing above can reach.
  // The cap is kept where the promise of a capped block is made, not asked of
  // the adapter: `MemoryAdapter` is a BYO seam, and one that answers `recall`
  // with a transcript must not be able to spend the whole prompt. Oldest first,
  // so the newest facts are the ones that survive the count.
  const memory = memoryPromptBlock(
    (input.memories ?? [])
      .slice(-MEMORY_RECALL_LIMIT)
      .map((text) => [...text].slice(0, MEMORY_TEXT_MAX_CHARS).join("")),
  );
  if (memory !== undefined) sections.push(memory);
  const situation = situationPromptBlock(input.situation);
  if (situation !== undefined) sections.push(situation);
  const directions = (input.directions ?? []).map((d) => d.trim()).filter((d) => d !== "");
  if (directions.length > 0) {
    sections.push(["Directions", ...directions.map((d) => `- ${d}`)].join("\n"));
  }
  return sections.join("\n\n");
}

/** A turn's system prompt, in EITHER venue: this package's assembly, then the
 *  host's last word on it. ONE resolution, because a chat turn and an away
 *  firing that thought with different briefs would be two agents wearing one
 *  name — the drift `AgentConfig.system` exists to prevent. */
export async function resolveSystem(
  deps: { guard: Guard; instructions?: string; system?: SystemPromptHook; memory?: MemoryAdapter },
  ctx: RunContext,
): Promise<string> {
  const directions = await deps.guard.directions(ctx);
  // Recalled per TURN, for the turn's own principal: a fact the previous turn's
  // `remember` call stored is in this one's prompt, and nothing a session holds
  // can go stale against it. VENUE IS DELIBERATELY IRRELEVANT — an away run
  // reads the person's memories exactly as a chat turn does (founder's call,
  // 2026-08-19), so an automation acting for someone is not a stranger to them.
  const memories = deps.memory === undefined
    ? []
    : await deps.memory.recall(ctx.principal, MEMORY_RECALL_LIMIT);
  const assembled = assemblePrompt({
    ...(deps.instructions === undefined ? {} : { instructions: deps.instructions }),
    ...(ctx.user === undefined ? {} : { user: ctx.user }),
    memories: memories.map((memory) => memory.text),
    ...(ctx.context === undefined ? {} : { situation: ctx.context }),
    directions,
  });
  return deps.system === undefined ? assembled : (await deps.system(ctx, { assembled, directions })) ?? assembled;
}
