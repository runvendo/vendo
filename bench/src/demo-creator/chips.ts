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
/** How many the derivation aims for when the surface allows it. */
export const targetDerivedChips = 5;
const minDerivedChips = 4;

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
  risk?: string;
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

/** A cheap non-streaming call on the stock ai SDK. Lazy import for the same
 * reason as the judge's: only the commands that need a model pay for it. */
export const defaultChipModel: ChipModelFn = async (prompt) => {
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

Reply with JSON ONLY, no prose or code fences:
{"chips":[{"key":"...","chip":"...","prompt":"..."}]}`;
}

/** Extracts the JSON object from a model reply that may carry fences or prose. */
export function parseChipsReply(raw: string): DemoBeat[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Chip derivation returned no JSON object:\n${raw.slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `Chip derivation returned unparseable JSON (${error instanceof Error ? error.message : String(error)}):\n${raw.slice(0, 500)}`,
    );
  }
  const chips = (parsed as { chips?: unknown }).chips;
  if (!Array.isArray(chips)) throw new Error(`Chip derivation returned no "chips" array:\n${raw.slice(0, 500)}`);
  const beats: DemoBeat[] = [];
  const seen = new Set<string>();
  for (const entry of chips) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, chip, prompt } = entry as Record<string, unknown>;
    if (typeof key !== "string" || typeof chip !== "string" || typeof prompt !== "string") continue;
    const slug = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug === "" || chip.trim() === "" || prompt.trim() === "" || seen.has(slug)) continue;
    seen.add(slug);
    // No expectsView/expectsApproval: a derived pill is not a verification
    // contract, so `demo-beats` only needs it to settle cleanly.
    beats.push({ key: slug, chip: chip.trim(), prompt: prompt.trim() });
  }
  if (beats.length < minDerivedChips) {
    throw new Error(`Chip derivation produced only ${beats.length} usable chips (need ${minDerivedChips}-${targetDerivedChips}):\n${raw.slice(0, 500)}`);
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
  /** Beats now in demo.config.json. */
  beats: DemoBeat[];
  /** How many came from the tool surface. */
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
    // No routes extracted yet (or none but auth plumbing). Leaving the config
    // untouched is correct: inventing pills is exactly what this replaces.
    write("[chips] no tool surface in .vendo/tools.json — leaving beats as they are");
    const kept = config.beats.filter((beat) => !isPlaceholderBeat(beat)).length;
    return { beats: config.beats, derived: 0, kept, skipped: "no-tools" };
  }

  const model = io.model ?? defaultChipModel;
  const derived = parseChipsReply(await model(buildChipsPrompt({ prospect: args.prospect ?? config.prospect, tools })));
  const beats = mergeBeats(config.beats, derived);
  const kept = beats.length - beats.filter((beat) => derived.some((candidate) => candidate.key === beat.key)).length;

  // Re-parse before writing: a derived beat that breaks the template's strict
  // schema must fail here, not at the app's next boot.
  const next = parseDemoConfig({ ...config, beats }, `derived demo config at "${configPath}"`);
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  write(`[chips] ${beats.length} pills from ${tools.length} extracted tools (${kept} kept, ${beats.length - kept} derived)`);
  return { beats, derived: beats.length - kept, kept };
}
