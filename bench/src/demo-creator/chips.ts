import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DemoBeat, DemoConfig } from "demo-template/demo-config";

/**
 * `demo:chips` — the demo's example pills, derived from the demo's OWN tool
 * surface instead of invented.
 *
 * The chip strip is the first thing a prospect reads, and until now every chip
 * was a string an agent made up from a plan. `vendo sync` already extracts the
 * app's real routes into `.vendo/tools.json`, so the honest source for "what
 * can I try here?" is that file: the pills then name capabilities the demo can
 * actually perform, in the prospect's own vocabulary.
 *
 * Deliberately one cheap model call and no judge loop — this is a sales tool,
 * and a wrong pill costs a confusing chip, not a broken demo. Explicit beats
 * always win: a hand-authored (or agent-authored) beat carries the
 * `expectsView`/`expectsApproval` contract that `demo-beats` verifies, so it
 * is kept verbatim and derived pills only fill the remainder.
 */

/** How many pills the strip shows at most, derived and explicit together. */
export const maxChips = 5;
/** How many the derivation aims for when the surface allows it. It is a
 * TARGET, not a floor: grounding drops whatever it must and the stage ships
 * fewer pills rather than padding the strip with ones that do not work. */
export const targetDerivedChips = 5;

/** The `TODO(creator): ` fence `demo:create` puts on the template's samples —
 * a placeholder is NOT an explicit beat and loses to a derived one. */
const placeholderFence = "TODO(creator): ";

export function isPlaceholderBeat(beat: DemoBeat): boolean {
  return beat.prompt.startsWith(placeholderFence) || beat.chip.startsWith(placeholderFence);
}

/** One entry of `.vendo/tools.json`, narrowed to what a chip needs. */
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
 * Reads the app's extracted tool surface. A missing or malformed file is not
 * an error: the app may simply have no OpenAPI routes yet, and the contract is
 * "no chips, no crash".
 */
export async function readExtractedTools(appDir: string): Promise<ExtractedTool[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(appDir, ".vendo", "tools.json"), "utf8");
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
 * judge takes the same rung and the rewrite stage shells out to the `claude`
 * CLI — so a chips stage that quietly fell back to the Cloud gateway would
 * only move the failure to the next stage. Say so up front instead: without a
 * provider key the whole pipeline is unusable, and an operator holding only a
 * Cloud key needs to know that here rather than read an SDK 401.
 */
export const defaultChipModel: ChipModelFn = async (prompt) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "demo:chips needs ANTHROPIC_API_KEY — the demo-creator harness runs on a provider key "
      + "(so do the fidelity judge and the rewrite agents), even though the demo it generates runs on VENDO_API_KEY. "
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
- Vary them: at least one that renders a view over data, and at least one that takes an action.
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
    // contract, so `demo-beats` only needs it to settle cleanly.
    beats.push({ key: slug, chip: chip.trim(), prompt: prompt.trim() });
  }
  // Ship fewer, never pad: a short strip of pills that all work beats a full
  // one carrying a pill that refuses when a prospect clicks it.
  if (dropped.length > 0) {
    onDropped?.(`${dropped.length} chip(s) dropped as ungrounded: ${dropped.join("; ")}`);
  }
  return beats.slice(0, targetDerivedChips);
}

/**
 * Explicit wins. Non-placeholder beats keep their order and their expectation
 * declarations; derived pills fill up to {@link maxChips}, skipping any key an
 * explicit beat already owns.
 */
export function mergeBeats(existing: readonly DemoBeat[], derived: readonly DemoBeat[]): DemoBeat[] {
  const explicit = existing.filter((beat) => !isPlaceholderBeat(beat));
  const taken = new Set(explicit.map((beat) => beat.key));
  const merged = [...explicit];
  for (const beat of derived) {
    if (merged.length >= maxChips) break;
    if (taken.has(beat.key)) continue;
    taken.add(beat.key);
    merged.push(beat);
  }
  return merged;
}

export interface DeriveChipsResult {
  /**
   * The pills this stage derived from the tool surface. EMPTY when the app has
   * no surface: with nothing to ground a pill in, the honest output is no
   * pills — inventing them is the behavior this stage exists to replace.
   */
  chips: DemoBeat[];
  /** What demo.config.json holds afterwards. Unchanged when `chips` is empty. */
  beats: DemoBeat[];
  /** How many of `beats` came from the tool surface. */
  derived: number;
  /** How many hand/agent-authored beats were kept verbatim. */
  kept: number;
  /** Set when the app has no usable tool surface — a no-op, not a failure. */
  skipped?: "no-tools";
}

export interface DemoChipsArgs {
  /** App directory; relative paths anchor at the repo root. */
  app: string;
  /** Overrides demo.config's `prospect` for the derivation prompt only. */
  prospect?: string;
}

const valueOptions = new Set(["--app", "--prospect"]);

export function parseDemoChipsArgs(argv: string[]): DemoChipsArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (!option?.startsWith("--")) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = normalizedArgv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options.set(option, value);
    index += 1;
  }
  const app = options.get("--app");
  if (app === undefined) throw new Error("--app is required (the demo app directory)");
  const prospect = options.get("--prospect");
  return { app, ...(prospect === undefined ? {} : { prospect }) };
}

export interface DeriveChipsIo {
  model?: ChipModelFn;
  write?: (line: string) => void;
}

/**
 * Derives the pills for one demo app and writes them into its
 * demo.config.json. Never widens the config's shape — downstream (the chip
 * strip, the capture harness, the caps guard) sees the same `beats` array it
 * always did.
 */
export async function runDeriveChips(
  args: { appDir: string; prospect?: string },
  io: DeriveChipsIo = {},
): Promise<DeriveChipsResult> {
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const configPath = path.join(args.appDir, "demo.config.json");
  const { parseDemoConfig } = await import("demo-template/demo-config");
  const config: DemoConfig = parseDemoConfig(
    JSON.parse(await readFile(configPath, "utf8")),
    `demo config at "${configPath}"`,
  );

  const tools = await readExtractedTools(args.appDir);
  if (tools.length === 0) {
    // No surface to ground anything in, so this stage derives NOTHING — the
    // whole point is that a pill names a real capability. The config is left
    // exactly as found: the demo keeps whatever beats it was authored with
    // (the template's strict schema requires at least one anyway), and no
    // model is called.
    write("[chips] no tool surface in .vendo/tools.json — deriving no chips");
    const kept = config.beats.filter((beat) => !isPlaceholderBeat(beat)).length;
    return { chips: [], beats: config.beats, derived: 0, kept, skipped: "no-tools" };
  }

  const model = io.model ?? defaultChipModel;
  const chips = parseChipsReply(
    await model(buildChipsPrompt({ prospect: args.prospect ?? config.prospect, tools })),
    tools,
    (message) => write(`[chips] ${message}`),
  );
  if (chips.length === 0) {
    // Grounding rejected everything. Shipping the demo's existing beats
    // untouched is the honest outcome — the alternative is padding the strip
    // with pills that refuse when a prospect clicks them.
    write("[chips] nothing survived grounding — leaving the demo's beats untouched");
    const keptOnly = config.beats.filter((beat) => !isPlaceholderBeat(beat)).length;
    return { chips: [], beats: config.beats, derived: 0, kept: keptOnly };
  }
  const beats = mergeBeats(config.beats, chips);
  const kept = beats.length - beats.filter((beat) => chips.some((candidate) => candidate.key === beat.key)).length;

  // Re-parse before writing: a derived beat that breaks the template's strict
  // schema must fail here, not at the app's next boot.
  const next = parseDemoConfig({ ...config, beats }, `derived demo config at "${configPath}"`);
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  write(`[chips] ${beats.length} pills from ${tools.length} extracted tools (${kept} kept, ${beats.length - kept} derived)`);
  return { chips, beats, derived: beats.length - kept, kept };
}
