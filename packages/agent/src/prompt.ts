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

const CAPABILITY_MISS_PROMPT = `When the user's ask cannot be fulfilled:
- If no available tool can perform it, call vendo_report_capability_miss with kind "no-matching-tool" before replying.
- If you explicitly give up after trying available approaches, call vendo_report_capability_miss with kind "agent-give-up" before replying.
- List only tool names you actually considered. Do not call the reporter for a pending approval or a policy-blocked call.
Repeated failures are detected automatically; if the reporter says the miss was already recorded, do not call it again.`;

/** 03-agent §3: company directions are mandatory policy context and fail closed. */
export async function assembleSystemPrompt(
  guard: Guard,
  ctx: RunContext,
  system?: { product?: string; instructions?: string },
  capabilityMiss = false,
): Promise<string> {
  const sections = [OPERATING_PROMPT];
  if (capabilityMiss) sections.push(CAPABILITY_MISS_PROMPT);
  const product = system?.product?.trim();
  if (product) sections.push(`Product\n${product}`);

  const directions = (await guard.directions(ctx))
    .map((direction) => direction.trim())
    .filter(Boolean);
  if (directions.length > 0) {
    sections.push(`Directions\n${directions.map((direction) => `- ${direction}`).join("\n")}`);
  }

  // 03-agent §3 item 4: v0 has no catalog/theme config; the umbrella folds it into system.instructions.
  const instructions = system?.instructions?.trim();
  if (instructions) sections.push(instructions);
  return sections.join("\n\n");
}
