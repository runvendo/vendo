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

// 03-agent §3 item (4): the catalog+theme summary rides only where generated
// trees can actually render — the chat surface and the app venue. Away
// automation runs and the MCP door get no component vocabulary.
const TREE_VENUES: ReadonlySet<RunContext["venue"]> = new Set(["chat", "app"]);

// Demo-refresh 2026-07-23: a rendered view owns its data — the reply around
// it must not compete with it. Venue-gated with the catalog: only surfaces
// that render trees have views to defer to.
const PRESENTATION_PROMPT = `Presentation
- When a view or app renders, it owns the data: never restate its data as a markdown table, list, or repeated numbers in your reply.
- Around a rendered view, reply with at most a sentence or two of insight the view does not already show.
- Do not narrate surface mechanics ("the chart is loading above", "see the table below").
- Match the product's voice. No emoji unless the user or the host's directions use them.`;

// Discovery-discipline 2026-07-25 (section id: discovery-budget) — a bounded
// discovery posture so a large connector catalog can never become a per-turn
// side-quest of searches, speculative unconnected calls, and approval spam.
const DISCOVERY_BUDGET_PROMPT = `Discovery budget
- Use vendo_tools_search at most 2 times per user intent; prefer the host's own tools whenever they can fulfill the ask.
- Never call a tool for a service you know is unconnected. A connect-required result means stop calling that service: tell the user what it needs. A connect card appears with that result on that turn only — on later turns, point the user to the connect (link) button in the message box instead; never claim a card "should have appeared".
- When a needed service is unconnected, say so plainly and surface the connect step — do not try other tools of the same service or hunt for substitutes across the catalog.`;

/** 03-agent §3: company directions are mandatory policy context and fail closed. */
export async function assembleSystemPrompt(
  guard: Guard,
  ctx: RunContext,
  // `product` accepts a resolver (cse lane 3): assembleSystemPrompt runs
  // per-turn, so a provider form is re-read every turn — the umbrella backs it
  // with a first-request cloud read so the brief resolves LIVE (a console
  // publish applies to the next turn with no restart). The string form is
  // unchanged.
  // `knowledge` accepts a resolver (knowledge k8): the umbrella locks it to
  // the boot-time index (status() is async, compose is sync), so per-turn
  // reads return the SAME bytes — prompt-cache stability is a hard criterion.
  system?: {
    product?: string | (() => string | undefined);
    catalog?: string;
    knowledge?: string | (() => string | undefined | Promise<string | undefined>);
    instructions?: string;
  },
  capabilityMiss = false,
  toolSearch = false,
): Promise<string> {
  const sections = [OPERATING_PROMPT];
  if (TREE_VENUES.has(ctx.venue)) sections.push(PRESENTATION_PROMPT);
  if (capabilityMiss) sections.push(CAPABILITY_MISS_PROMPT);
  if (toolSearch) sections.push(DISCOVERY_BUDGET_PROMPT);
  const product = (typeof system?.product === "function" ? system.product() : system?.product)?.trim();
  if (product) sections.push(`Product\n${product}`);

  const directions = (await guard.directions(ctx))
    .map((direction) => direction.trim())
    .filter(Boolean);
  if (directions.length > 0) {
    sections.push(`Directions\n${directions.map((direction) => `- ${direction}`).join("\n")}`);
  }

  // 03-agent §3 item (4) — the umbrella assembles the summary (AGENT-1); the
  // agent places it, venue-gated.
  const catalog = system?.catalog?.trim();
  if (catalog && TREE_VENUES.has(ctx.venue)) sections.push(catalog);

  // Knowledge k8 (ENG-368): the static index + usage guidance rides only the
  // venues whose turns go through this assembler with a knowledge-capable
  // surface (chat + app); automation and MCP rely on the tool descriptor.
  const knowledge = (await (typeof system?.knowledge === "function" ? system.knowledge() : system?.knowledge))?.trim();
  if (knowledge && TREE_VENUES.has(ctx.venue)) sections.push(knowledge);

  const instructions = system?.instructions?.trim();
  if (instructions) sections.push(instructions);
  return sections.join("\n\n");
}
