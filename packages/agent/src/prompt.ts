import type { Guard, RunContext } from "@vendoai/core";

const OPERATING_PROMPT = `You are Vendo's agent.
Act through the host's available tools on behalf of the signed-in user.
Stay within the user's request and use the authority available in this context.
Ask for approval whenever the guard requires it.
If a call is blocked, explain the constraint and adapt your approach.
If a call is queued for approval, say what is pending and continue where useful.
Never claim a tool ran unless its result confirms that it did.
Never invent tool outputs, records, or side effects.
For away runs, clearly state what completed and what was left pending.`;

/** 03-agent §3 */
export async function assembleSystemPrompt(
  guard: Guard,
  ctx: RunContext,
  system?: { product?: string; instructions?: string },
): Promise<string> {
  const sections = [OPERATING_PROMPT];
  const product = system?.product?.trim();
  if (product) sections.push(`Product\n${product}`);

  try {
    const directions = (await guard.directions(ctx))
      .map((direction) => direction.trim())
      .filter(Boolean);
    if (directions.length > 0) {
      sections.push(`Directions\n${directions.map((direction) => `- ${direction}`).join("\n")}`);
    }
  } catch {
    // Guard directions are fail-soft context, not an execution gate.
  }

  // 03-agent §3 item 4: v0 has no catalog/theme config; the umbrella folds it into system.instructions.
  const instructions = system?.instructions?.trim();
  if (instructions) sections.push(instructions);
  return sections.join("\n\n");
}
