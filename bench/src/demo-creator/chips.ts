import { readFile } from "node:fs/promises";
import type { DemoBeat } from "demo-template/demo-config";

/**
 * Chip grounding — the demo's example pills, derived from the demo's OWN tool
 * surface instead of invented.
 *
 * The chip strip is the first thing a prospect reads, and once every chip was a
 * string an agent made up from a plan. `vendo sync` extracts the demo's real
 * routes into a tools.json, so the honest source for "what can I try here?" is
 * that file: the pills then name capabilities the demo can actually perform, in
 * the prospect's own vocabulary.
 *
 * Deliberately one cheap model call and no judge loop — this is a sales tool,
 * and a wrong pill costs a confusing chip, not a broken demo. Authored beats
 * always win: the beats agent's own beat carries the
 * `expectsView`/`expectsApproval` declarations the beat arc is validated on
 * (demo-folder.ts's `beatVarietyProblems`), so it is kept verbatim and derived
 * pills only fill the remainder.
 *
 * The caller is build.ts's grounding pass (stage 3 of `demo:pipeline`).
 */

/** How many pills the strip shows at most, derived and explicit together. */
export const maxChips = 5;
/** How many the derivation aims for when the surface allows it. It is a
 * TARGET, not a floor: grounding drops whatever it must and the stage ships
 * fewer pills rather than padding the strip with ones that do not work. */
export const targetDerivedChips = 5;

/** One entry of the demo's tools.json, narrowed to what a chip needs. */
export interface ExtractedTool {
  name: string;
  description?: string;
  summary?: string;
  risk?: string;
}

/**
 * Glue that carries no capability meaning. Kept deliberately tight: a token
 * wrongly treated as meaningful can let an unrelated chip through (the failure
 * this check exists to stop), while a meaningful token wrongly dropped only
 * costs us a pill — and shipping fewer pills is the safe direction.
 */
const stopwords = new Set([
  "a", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do",
  "does", "for", "from", "get", "had", "has", "have", "her", "him", "his", "how", "its", "just", "let",
  "make", "may", "me", "mine", "more", "most", "much", "must", "my", "new", "not", "now", "off", "one",
  "only", "onto", "our", "out", "over", "own", "per", "please", "put", "should", "so", "some", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through",
  "too", "under", "until", "use", "very", "was", "way", "were", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "would", "you", "your",
  // The extraction prefix itself, and HTTP verbs that ride generated descriptions.
  "host", "vendo", "api", "delete", "patch", "post", "put",
])

/**
 * Text → the set of meaningful tokens it carries.
 *
 * camelCase is split BEFORE lowercasing: tool names are `host_createOrder`,
 * and splitting on non-alphanumerics alone would yield the single token
 * `createorder`, which matches no human sentence — the name half of the
 * grounding check would be dead weight. A trailing "s" is folded so
 * "invoice"/"invoices" agree; two-character tokens are dropped as noise (this
 * is also what reduces placeholder text like "c0"/"p0" to nothing at all).
 */
export function meaningfulTokens(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !stopwords.has(token))
      .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token)),
  )
}

/** What a capability is "about": its name (minus the extraction prefix) plus
 * whatever prose the extractor recorded for it. */
export function capabilityTokens(tool: ExtractedTool): Set<string> {
  return meaningfulTokens(`${tool.name} ${tool.summary ?? ""} ${tool.description ?? ""}`)
}

/**
 * Reads an extracted tool surface, given the PATH of the tools.json — no layout
 * opinion at all, because `vendo sync` writes it to `<root>/.vendo/tools.json`
 * while the frozen demo-folder contract keeps it at `demos/<slug>/tools.json`.
 *
 * A missing or malformed file is not an error: the demo may simply have no
 * OpenAPI routes yet, and the contract is "no chips, no crash" — the caller
 * decides whether zero tools is fatal.
 */
export async function readExtractedTools(toolsPath: string): Promise<ExtractedTool[]> {
  let raw: string;
  try {
    raw = await readFile(toolsPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const tools = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null)
    .map((tool) => ({
      name: String(tool["name"] ?? ""),
      ...(typeof tool["description"] === "string" ? { description: tool["description"] } : {}),
      ...(typeof tool["summary"] === "string" ? { summary: tool["summary"] } : {}),
      ...(typeof tool["risk"] === "string" ? { risk: tool["risk"] } : {}),
    }))
    .filter((tool) => tool.name !== "" && isProductTool(tool.name));
}

/** Auth/session plumbing is a route, not a capability — nobody demos
 * "POST /api/auth/{nextauth}". Host tools are what `vendo sync` names from the
 * app's own OpenAPI spec. */
function isProductTool(name: string): boolean {
  return name.startsWith("host_") && !/^host_auth(_|$)/.test(name);
}

/** Model seam: prompt in, raw model text out. Mirrors judge.ts's JudgeModelFn
 * so tests drive the derivation without a key. */
export type ChipModelFn = (prompt: string) => Promise<string>;

/**
 * A cheap non-streaming call on the stock ai SDK. Lazy import for the same
 * reason as the judge's: only the commands that need a model pay for it.
 *
 * OPERATOR-side credential, deliberately NOT the Vendo ladder. The demo this
 * generates rides VENDO_API_KEY (see apps/demo-template's Cloud posture), but
 * the creator harness itself is Anthropic-bound end to end — the fidelity
 * judge takes the same rung and the build agents shell out to the `claude`
 * CLI — so a chips stage that quietly fell back to the Cloud gateway would
 * only move the failure to the next stage. Say so up front instead: without a
 * provider key the whole pipeline is unusable, and an operator holding only a
 * Cloud key needs to know that here rather than read an SDK 401.
 */
export const defaultChipModel: ChipModelFn = async (prompt) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Chip grounding needs ANTHROPIC_API_KEY — the demo-creator harness runs on a provider key "
      + "(so do the fidelity judge and the build agents), even though the demo it generates runs on VENDO_API_KEY. "
      + "Source the Flowlet .env, or pass your own model via the `model` seam.",
    );
  }
  const [{ createAnthropic }, { generateText }] = await Promise.all([
    import("@ai-sdk/anthropic"),
    import("ai"),
  ]);
  const anthropic = createAnthropic({});
  const result = await generateText({
    model: anthropic(process.env.VENDO_DEMO_CHIPS_MODEL ?? "claude-sonnet-5"),
    prompt,
  });
  return result.text;
};

export function buildChipsPrompt(options: { prospect: string; tools: readonly ExtractedTool[] }): string {
  const surface = options.tools
    .map((tool) => `- ${tool.name}${tool.risk === undefined ? "" : ` [${tool.risk}]`}: ${tool.description ?? "(no description)"}`)
    .join("\n");
  return `You are writing the example prompts shown as clickable pills above the chat in a ${options.prospect} product demo.

This is ${options.prospect}'s ACTUAL tool surface — every capability the demo's agent can invoke, extracted from the app's own routes:

${surface}

Write ${targetDerivedChips} example prompts a ${options.prospect} user would plausibly type. Rules:
- Each one must be achievable with the tools above. Never invent a capability that is not listed.
- Write in ${options.prospect}'s domain vocabulary, not in API terms — say "overdue invoices", not "host_listInvoices".
- Imperative, not questions ("Show me ...", "Draft ...") — a question gets a prose answer instead of a generated view.
- Vary them across the five things this product's agent can do: render a VIEW over data, take an ACTION (with the user's approval), set up a recurring AUTOMATION, CONNECT an outside account (Gmail, Google Calendar or Slack), and SAVE a generated view as a reusable app. One of each, in that order, whenever the surface above supports it.
- "chip" is a short label (2-5 words, sentence case). "prompt" is the full sentence typed into the composer.
- "key" is a lowercase-hyphenated slug, unique.
- NEVER name a specific record id, invoice number, customer or ticket in the prompt. You cannot see the demo's seeded data, so an invented id ("Void invoice INV-1042") sends the agent looking for a record that does not exist and the pill dead-ends in front of the prospect. Phrase actions over a described record instead ("the oldest unpaid invoice", "the largest open dispute").
- "tools" lists the tool names from the surface above that the prompt needs, copied EXACTLY. At least one. Do not guess a name.
- Two automatic checks discard a pill, so write to pass them: the cited names must exist in the surface above, AND the visible chip+prompt must share at least one real word with the cited capability's name or description. Say "invoices" for a tool about invoices — a pill whose wording has nothing in common with what it cites is thrown away.

Reply with JSON ONLY, no prose or code fences:
{"chips":[{"key":"...","chip":"...","prompt":"...","tools":["host_..."]}]}`;
}

/**
 * Pulls the `chips` array out of a model reply.
 *
 * Not "first `{` to last `}`": observed live, a model answered with one
 * object, wrote "Wait, I need a single JSON object", then emitted the corrected
 * one — and spanning brace-to-brace swallowed all three fragments into
 * something unparseable. So scan for COMPLETE top-level objects (brace depth,
 * string- and escape-aware) and take the LAST one that actually carries chips:
 * when a model corrects itself, its final answer is the one it means.
 */
function extractChipsArray(raw: string): unknown[] | undefined {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const chips = (parsed as { chips?: unknown }).chips;
    if (Array.isArray(chips) && chips.length > 0) return chips;
  }
  return undefined;
}

/**
 * Extracts the pills from a model reply (which may carry fences or prose) and
 * GROUNDS each one in the supplied surface.
 *
 * Shape and count are not evidence of anything: a model can return five
 * beautifully-formed pills for capabilities the demo does not have, and a
 * prospect clicking one gets a refusal. So every pill must cite the tools it
 * needs, by exact name, and a pill citing anything outside `surface` is
 * dropped as invented — the pills are deliberately written in domain language
 * ("overdue invoices", not `host_listInvoices`), so the citation is the only
 * honest link back to the real capability.
 *
 * The citations are validation input only; they never reach demo.config.json
 * (its shape is fixed, and the chip strip has no use for them).
 */
export function parseChipsReply(
  raw: string,
  surface: readonly ExtractedTool[],
  onDropped?: (message: string) => void,
): DemoBeat[] {
  const chips = extractChipsArray(raw);
  if (chips === undefined) {
    throw new Error(`Chip derivation returned no usable {"chips": [...]} object:\n${raw.slice(0, 800)}`);
  }

  const byName = new Map(surface.map((tool) => [tool.name, tool]));
  const beats: DemoBeat[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const entry of chips) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, chip, prompt, tools } = entry as Record<string, unknown>;
    if (typeof key !== "string" || typeof chip !== "string" || typeof prompt !== "string") continue;
    const slug = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug === "" || chip.trim() === "" || prompt.trim() === "" || seen.has(slug)) continue;

    // (1) The citation must name capabilities this demo actually has.
    const cited = Array.isArray(tools) ? tools.filter((name): name is string => typeof name === "string") : [];
    const unknown = cited.filter((name) => !byName.has(name));
    if (cited.length === 0 || unknown.length > 0) {
      dropped.push(`"${chip.trim()}" (${cited.length === 0 ? "cites no tool" : `unknown tool: ${unknown.join(", ")}`})`);
      continue;
    }

    // (2) …and the VISIBLE text must actually be about one of them. Without
    // this the citation is just the model's own say-so: filler like "c0"/"p0"
    // attached to a real tool name would sail through and reach a prospect.
    const visible = meaningfulTokens(`${chip} ${prompt}`);
    const grounded = cited.some((name) => {
      for (const token of capabilityTokens(byName.get(name) as ExtractedTool)) {
        if (visible.has(token)) return true;
      }
      return false;
    });
    if (!grounded) {
      dropped.push(`"${chip.trim()}" (text shares nothing with ${cited.join(", ")})`);
      continue;
    }

    seen.add(slug);
    // No expectsView/expectsApproval: a derived pill is not a verification
    // contract, and the beat arc's required declarations ride the authored
    // beats it merges behind.
    beats.push({ key: slug, chip: chip.trim(), prompt: prompt.trim() });
  }
  // Ship fewer, never pad: a short strip of pills that all work beats a full
  // one carrying a pill that refuses when a prospect clicks it.
  if (dropped.length > 0) {
    onDropped?.(`${dropped.length} chip(s) dropped as ungrounded: ${dropped.join("; ")}`);
  }
  return beats.slice(0, targetDerivedChips);
}

/** What a prospect actually reads on a pill, normalised for comparison. */
function wording(beat: DemoBeat): string {
  return `${beat.chip.trim().toLowerCase()}|${beat.prompt.trim().toLowerCase()}`;
}

/**
 * Existing beats win. Every one keeps its order and its expectation
 * declarations; derived pills fill up to {@link maxChips}.
 *
 * Three things this deduplicates, all of which shipped a visible duplicate chip:
 *  - an AUTHORED duplicate key (the old `[...existing]` copied them verbatim;
 *    `taken` only ever stopped a derived collision);
 *  - a derived pill whose key an existing beat owns;
 *  - a derived pill whose WORDING an existing beat already carries — which is
 *    exactly what regrounding produces: it rewrites an ungrounded beat's text
 *    with a derived pill and keeps the beat's key, so appending that pill again
 *    under its own key put the same sentence on the strip twice.
 *
 * The cap applies to the whole result, not only to the appending loop.
 */
export function mergeBeats(existing: readonly DemoBeat[], derived: readonly DemoBeat[]): DemoBeat[] {
  const taken = new Set<string>();
  const said = new Set<string>();
  const merged: DemoBeat[] = [];
  for (const beat of [...existing, ...derived]) {
    if (merged.length >= maxChips) break;
    if (taken.has(beat.key) || said.has(wording(beat))) continue;
    taken.add(beat.key);
    said.add(wording(beat));
    merged.push(beat);
  }
  return merged;
}
