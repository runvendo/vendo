/**
 * The system prompt, assembled per turn.
 *
 * It lives in the umbrella because the umbrella is what knows the brief, the
 * catalog and the knowledge index. It rides the turn (`Turn.system`), so every
 * harness — the default one, a host's own — thinks on the same brief.
 */
import { situationPromptBlock, userPromptBlock, type Guard, type RunContext } from "@vendoai/core";

const OPERATING_PROMPT = `You are Vendo's agent.
Act through the host's available tools on behalf of the signed-in user.
Stay within the user's request and use the authority available in this context.
Ask for approval whenever the guard requires it.
If a call is blocked, explain the constraint and adapt your approach.
If a call is queued for approval, say what is pending and continue where useful.
Never claim a tool ran unless its result confirms that it did.
Never invent tool outputs, records, or side effects.
A tool result whose status is "building" (or otherwise not yet final) is not done — never say it succeeded, never describe or invent what it contains, and never report a build as anything but failed once its result says it failed.
For away runs, clearly state what completed and what was left pending.
When someone asks for something to look at, track, or use — a dashboard, a list, a recurring report — build them an app instead of describing the data in text; the building-apps skill is the manual.

Voice (design §3 — you are talking to a customer, not a developer)
- Never put a tool, function, or file identifier in anything the user reads. Each tool's description leads with its human title before an em dash; say the title ("Send money"), never the identifier ("host_transferMoney") — not even in backticks, not even to explain a limit.
- Plain language: no code, no paths, no schema or API jargon.
- Friendly is not vague: name the material arguments of what you did ("Sent $1,400 to Acme Utilities", never "Sent a payment").`;

// The carve-out on the first bullet is load-bearing (uiaudit 2026-08-06): a
// request for an unconnected service met every word of "no available tool can
// perform it", so reporting a miss and replying in prose read as compliance with
// this section while the connect etiquette below was asking for the opposite. Two
// instructions, one situation, and the model may satisfy either.
const CAPABILITY_MISS_PROMPT = `When the user's ask cannot be fulfilled:
- If no available tool can perform it, call vendo_report_capability_miss with kind "no-matching-tool" before replying.
- An outside service this user has not connected is not a capability miss: ask for it with request_connection instead of reporting one.
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

// The connect etiquette, shared verbatim by both discovery sections below: it is
// load-bearing on every surface that can reach a connector, and one copy is what
// keeps the two from drifting apart.
//
// The ASK lives here too, and that is the whole point (uiaudit 2026-08-06): the
// `vendo()` engine — the demo and every composed route — only ever gets
// DISCOVERY_BUDGET_PROMPT, so teaching `request_connection` in the connectors
// section alone meant the engine's model never read it, while this bullet told it
// to send the user hunting for the connect button. The card appeared on 2 of 6
// identical prompts. One copy, both surfaces, one instruction.
//
// Every substitute named below was measured, not imagined — the button-hunt is
// what the old text prescribed, and on the first live run of the fixed prompt the
// model called list_connections, learned Gmail was unconnected, and hand-wrote the
// email in chat for the user to copy. An instruction that leaves any graceful
// alternative gets the alternative, which is also why there is no hedge for a
// deployment with no connectors: the model's tool list is the ground truth about
// what it can call, and the hedge was one more licensed way out of asking.
//
// The TRIGGER is the first bullet, and it is the other half of the same defect:
// the zero-key Cloud default connector registers no service-tool descriptors at
// all, so on the shipped demo there is no Gmail tool to find and no
// connect-required result to stop on — `list_connections` is the only thing that
// can tell the model the state, and nothing told it to call it. An ask whose
// every clause begins "when you learn" fires only when the model happens to look.
const CONNECT_ETIQUETTE = `- When the ask needs an outside service the host's own tools do not cover — email, calendar, chat, docs — call list_connections before you answer: it is the only thing that tells you whether this user has connected it.
- Never call a tool for a service you know is unconnected. A connect-required result means stop calling that service.
- Ask for it instead: call request_connection with that service's toolkit and one plain sentence saying why, then stop and wait. Ask on the turn you learn the service is unconnected — including when list_connections is what told you — and again on any later turn the need comes back.
- Nothing substitutes for the ask: never send the user off to find the connect button, never try other tools of the same service, never reach for a different service, and never hand-write the result in chat as a consolation prize. Never claim a card "should have appeared".`;

// Discovery-discipline 2026-07-25 (section id: discovery-budget) — a bounded
// discovery posture so a large connector catalog can never become a per-turn
// side-quest of searches, speculative unconnected calls, and approval spam.
const DISCOVERY_BUDGET_PROMPT = `Discovery budget
- Use find_tools at most 2 times per user intent; prefer the host's own tools whenever they can fulfill the ask.
${CONNECT_ETIQUETTE}`;

// Harness redesign D8 2026-08-03 (section id: connectors) — the claude-code surface
// has no loadout and no `find_tools`, so there is no search budget to keep; what is
// left is the outside-service catalog and the same connect etiquette.
//
// Connector discovery 2026-08-03: the loop is find → connect if needed → use. No
// tool of an outside service is ever ON your list, so there is no name to look up
// there and no server prefix to reconcile — `use_service_tool` takes the broker's
// own slug verbatim.
const CONNECTORS_PROMPT = `Connectors
- find_service_tools searches outside services by intent; each match comes back with the slug to use, its argument schema, and whether this user has connected that service. use_service_tool then runs one of them. list_connections shows which services exist and whether this user has connected them. Prefer the host's own tools whenever they can fulfill the ask.
- Outside-service tools are never on your own tool list: reach them only through use_service_tool, passing the slug exactly as find_service_tools returned it. Never guess a slug, and never invent arguments — use the schema that came back with the match, and if a match came back without one, ask the user for what it needs.
${CONNECT_ETIQUETTE}`;

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
  // Which discovery machinery this turn's harness actually has (D8): the
  // `vendo()` loadout's `find_tools` budget, the claude-code surface's two
  // Composio-scoped tools, or neither. One assembler, never a forked prompt —
  // the mid-conversation harness swap depends on the shared policy text.
  discovery: "find-tools" | "connectors" | false = false,
): Promise<string> {
  const sections = [OPERATING_PROMPT];
  if (TREE_VENUES.has(ctx.venue)) sections.push(PRESENTATION_PROMPT);
  if (capabilityMiss) sections.push(CAPABILITY_MISS_PROMPT);
  if (discovery !== false) {
    sections.push(discovery === "connectors" ? CONNECTORS_PROMPT : DISCOVERY_BUDGET_PROMPT);
  }
  const product = (typeof system?.product === "function" ? system.product() : system?.product)?.trim();
  if (product) sections.push(`Product\n${product}`);

  // Spec 2026-08-05 §1 — the host's asserted profile of the present user
  // (ctx.user, server-trust, refreshed per request by the auth preset's
  // resolver). Spec 2026-08-05 §2 — what the user's screen currently shows,
  // THIS turn only (never persisted: it rides the request ctx and Turn.system,
  // nothing the store writes). Both blocks are core's, shared verbatim with
  // @vendoai/agents' assemblePrompt: the section-forgery indent is a
  // prompt-injection defence and it gets exactly one implementation.
  const user = userPromptBlock(ctx.user);
  if (user !== undefined) sections.push(user);
  const situation = situationPromptBlock(ctx.context);
  if (situation !== undefined) sections.push(situation);

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
