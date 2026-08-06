/**
 * What a fill worker is told (generation pipeline rebuild, Task 7). A worker is
 * one fast, no-think model call that writes ONE group of the plan, and it is
 * deliberately BLINKERED: it sees its own group, the queries that group's
 * leaves read, and the docs for the components those leaves name — nothing
 * about the rest of the app. That is what makes N groups fill in parallel
 * without agreeing on anything, and what keeps each prompt small enough to be
 * fast.
 *
 * Yousef iterates on this text — keep it one screen.
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  describeShapeWithSemantics,
  kitPrompt,
  type NormalizedCatalog,
  type PlanGroup,
  type PlanQuery,
} from "@vendoai/core";
import { hostDesignBrief } from "../contracts/sections.js";
import { PREWIRED_SCHEMAS } from "../../prewired-schema.js";
import type { GenerationDependencies } from "../engine.js";

/** One query result trimmed to this many characters of JSON. Enough rows to
 *  show a worker what its fields really look like, small enough that a long
 *  table cannot crowd out the section it is meant to fill. */
const MAX_SAMPLE_CHARS = 600;

// Yousef iterates on this text — keep it one screen.
const ROLE = `You are filling in ONE section of an app somebody asked for. The app's layout already exists and its container is already on the screen, waiting for its contents.

Write ONLY the markup that goes inside your section: one element per part listed below, in that order, and nothing else — no <App>, no wrapper around them, no explanation, no markdown fences.

SHOW WHAT IS IN THE DATA. Every number, name, date, and status on the screen is a reference to one of the queries below. Never type a value yourself, however plausible it looks — a made-up figure is indistinguishable from a real one to the person reading it, which makes it the worst thing this section can ship. When a part's data is genuinely missing, let the component render its own empty state; never fill the hole with an example.

Write a reference in braces, starting with the query's name: rows={invoices}, cents={invoice.total_cents}. Text you write yourself is fine for LABELS and headings ("Outstanding", "Worst first") — never for data.

NUMBERS YOU WORK OUT — one way, always this one. Never do the arithmetic yourself; write the calculation and the runtime computes it fresh on every render, so a total can never go stale: value={sum(transactions, "amount_cents")}. Inside those braces you have the query's field paths, numbers, quoted strings, + - * / ( ), and the calls sum, count, average, min, max, difference, days_until, group_by — nothing else. Every aggregate NAMES the field it reads, rows first; there is no "|" pipe and no "avg".

You can only see your own section. Do not write anything belonging elsewhere in the app, and do not repeat the section's own heading — it is already on the screen above you.`;

/** The docs for exactly the components this group's leaves name: the host's own
 *  entries (schema and all — a host component is the brand-native answer), then
 *  the Kit and legacy primitives from the generated specs. */
const componentDocs = (group: PlanGroup, catalog: NormalizedCatalog): string => {
  const named = new Set(group.leaves.map(({ component }) => component));
  const host = catalog.filter(({ name }) => named.has(name));
  const kit = KIT_WIRE_COMPONENT_NAMES.filter((name) => named.has(name));
  const legacy = Object.entries(PREWIRED_SCHEMAS).filter(([name]) => named.has(name));
  return [
    host.length === 0 ? "" : `THIS HOST'S OWN COMPONENTS (use these exact prop names):\n${JSON.stringify(
      host.map(({ name, description, propsJsonSchema, examples }) => ({
        name,
        whenToUse: description,
        propsJsonSchema: propsJsonSchema ?? null,
        examples: examples ?? [],
      })),
      null,
      2,
    )}`,
    kit.length === 0 ? "" : kitPrompt({ only: [...kit] }),
    legacy.length === 0 ? "" : `PRIMITIVES:\n${legacy.map(([, schema]) => `- ${schema.signature}`).join("\n")}`,
  ].filter((section) => section !== "").join("\n\n");
};

/** The worker's system prompt: the role, then the docs for its own components.
 *  Per-group by design — a shared prefix would mean showing every worker the
 *  whole catalog, which is the blinkering this lane exists to remove. */
export const workerSystemPrompt = (deps: GenerationDependencies, group: PlanGroup): string =>
  [
    ROLE,
    componentDocs(group, deps.catalog),
    // The worker writes the markup, so the host's stated design rules and brand
    // tokens have to reach IT — they are host configuration, not prompt polish,
    // and a section written without them ignores what the host asked for.
    hostDesignBrief(deps),
  ].filter((section) => section !== "").join("\n\n");

export interface WorkerFillInput {
  /** The app's display name — the only thing about the wider app a worker sees. */
  appName: string;
  group: PlanGroup;
  /** The plan's queries this group's leaves actually read. */
  queries: readonly PlanQuery[];
  /** What those queries returned at plan time, keyed by query id. Absent for a
   *  query the host could not read. */
  samples: Readonly<Record<string, unknown>>;
  /** Problems with the worker's previous fresh attempt, when there was one. */
  problems?: readonly string[];
}

const sample = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "null";
  return text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}…` : text;
};

/** One query as the worker meets it: how it is read, the shape of what comes
 *  back, and real rows from the actual read. */
const queryBriefs = (input: WorkerFillInput, deps: GenerationDependencies): string => input.queries
  .map((query) => {
    const shape = deps.toolShapes?.[query.tool];
    return [
      `${query.id} — read with ${query.tool}(${JSON.stringify(query.input)})`,
      shape === undefined ? "" : `  shape: ${describeShapeWithSemantics(shape, deps.semantics?.[query.tool] ?? {})}`,
      query.id in input.samples
        ? `  real rows: ${sample(input.samples[query.id])}`
        : "  real rows: this read did not come back, so bind the fields the shape names and let empty states show.",
    ].filter((line) => line !== "").join("\n");
  })
  .join("\n");

/** The fill turn: the app's name, the section to write, and its data. */
export const workerFillMessage = (
  input: WorkerFillInput,
  deps: GenerationDependencies,
): string => {
  const { group } = input;
  const where = [
    group.tab === undefined ? "" : `in the "${group.tab}" tab`,
    group.title === undefined ? "" : `titled "${group.title}"`,
  ].filter((part) => part !== "").join(", ");
  return [
    `THE APP: "${input.appName}"`,
    `YOUR SECTION${where === "" ? "" : ` (${where})`}, one element per part, in this order:\n${group.leaves
      .map((leaf) => `- <${leaf.component}> — ${leaf.purpose}${leaf.attrs === undefined ? "" : ` [${Object.entries(leaf.attrs).map(([name, value]) => `${name}=${value}`).join(" ")}]`}`)
      .join("\n")}`,
    input.queries.length === 0
      ? "THIS SECTION HAS NO DATA to read, so write honest static content only — never a number or a name that looks real."
      : `THE DATA your section shows:\n${queryBriefs(input, deps)}`,
    ...(input.problems === undefined || input.problems.length === 0 ? [] : [
      `YOUR LAST ATTEMPT DID NOT WORK:\n${input.problems.map((problem) => `- ${problem}`).join("\n")}\nWrite the section again, fixed.`,
    ]),
  ].join("\n\n");
};

/** The fix-it turn: the section as it stands and what is wrong with it, edited
 *  the way the brain edits an app — exact old text, exact replacement. */
export const workerFixMessage = (fragment: string, problems: readonly string[]): string => [
  `THE SECTION YOU WROTE (this exact text is what an <Old> must quote):\n${fragment}`,
  `WHAT IS WRONG WITH IT:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
  `Fix every one of them with edits over that text, and write nothing else:
<Edit>
  <Old>the exact text being replaced</Old>
  <New>what replaces it</New>
</Edit>
One <Edit> per replacement, as many as the fixes need. <Old> is copied EXACTLY from the text above and has to appear there exactly once — include a surrounding line when it would otherwise match twice. To remove something, leave <New> empty.`,
].join("\n\n");
