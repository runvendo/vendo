/**
 * Shared prompt sections — the pieces every generation contract composes from:
 * the theme/design-rules pair, the host tool/shape sections, the generated
 * COMPONENTS section, and the island contract.
 *
 * `generationPromptSections` — one monolithic JSON-era contract covering the
 * role line, the v2 tree contract, the clock, component styling and the catalog
 * — lived here with no caller left; the dialect contracts each compose their own
 * sections now. Deleted 2026-08-05 rather than left to rot into a second,
 * silently diverging source of truth about the tree.
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  describeShapeWithSemantics,
  kitPrompt,
  ISLAND_AMBIENT_KIT_NAMES,
} from "@vendoai/core";
import { prewiredSchemaPrompt } from "../../prewired-schema.js";
import type { GenerationDependencies } from "../engine.js";

export interface GenerationPromptSection {
  id: "role" | "tree-contract" | "clock" | "catalog" | "theme" | "design-rules" | "limits";
  content: string;
}

export const composePromptSections = (sections: readonly GenerationPromptSection[]): string => sections
  .map(({ content }) => content.trim())
  .filter((content) => content.length > 0)
  .join("\n\n");

/**
 * The host's own facts, as prompt sections — shared by every actor that needs
 * them (the brain planning, the workers writing markup).
 *
 * These are the HOST'S configuration, not prompt polish: `apps.designRules` and
 * the theme tokens are documented seams a host sets and expects to be obeyed.
 * A prompt that omits them makes those config keys silently do nothing.
 */
export const hostDesignRulesSection = (deps: GenerationDependencies): GenerationPromptSection[] => {
  const rules = (typeof deps.designRules === "function" ? deps.designRules() : deps.designRules)?.trim();
  // The section is emitted even when the host set no rules: "(none provided)" is
  // the difference between a model that knows there are no house rules and one
  // that was never told either way.
  return [{
    id: "design-rules" as const,
    content: `HOST DESIGN RULES:\n${rules === undefined || rules === "" ? "(none provided)" : rules}`,
  }];
};

export const hostThemeSection = (deps: GenerationDependencies): GenerationPromptSection[] =>
  deps.theme === undefined ? [] : [{
    id: "theme" as const,
    content: `THEME TOKENS:\n${JSON.stringify(deps.theme, null, 2)}`,
  }];

/** The COMPONENTS section is GENERATED from the component schemas (kitPrompt
 *  over the Kit specs + the legacy primitive signatures); no hand-written
 *  component list survives here. Deps-independent, so it is rendered once per
 *  process (perf budget: gen-scripted:create). */
let componentsPromptCache: string | undefined;
export const componentsPromptSection = (): string => componentsPromptCache ??= `COMPONENTS (generated from the component schemas — use these EXACT component and prop names; an unknown prop is silently dropped and fails validation):

${kitPrompt({ only: [...KIT_WIRE_COMPONENT_NAMES] })}

# Legacy primitives (also available)
${prewiredSchemaPrompt()}`;

/** The island contract, shared by the create and edit dialects. The
 *  "LAST RESORT" fear rules are retired: use the Kit when it covers the need
 *  (faster, branded); write an island for custom visuals/logic/interaction.
 *  Byte caps, the TSX + default-export gate, and the no-network CSP all
 *  stand. */
export const islandContract = (): string => `- <Island name="PascalName">TSX with an \`export default\` component</Island> defines a generated component, referenced as <PascalName/> — plain source, never wrapped in braces, template literals, or fences. The island's name must be DISTINCT from every host catalog, Kit, and prewired component name (name resolution prefers those, so a colliding island never renders). Use a host catalog or Kit/prewired component when it covers the need (faster, brand-native); write an island for custom visuals, novel interactions, or client-side logic they cannot express (search-as-you-type, derived calculations). A CHART is not a custom visual: a bar/line/donut/sparkline/progress belongs in the Kit chart (BarChart, LineChart, DonutChart, Sparkline, Progress) — those render a designed empty state on empty data for free, so never hand-roll a chart island (an SVG donut, a bespoke bars grid). Never put the whole app or its layout inside one island: compose regions so the app streams in progressively.
- Islands have NO import statements — everything is already in scope: React and its hooks (useState, useEffect, useMemo, useCallback, useRef), the entire Kit (${ISLAND_AMBIENT_KIT_NAMES.join(", ")}), and \`fmt\` value helpers (fmt.money(cents), fmt.dateTime(iso), fmt.percent(ratio), fmt.num(n)). Never write an import: known react/kit imports are stripped, and anything else (recharts, d3, lodash…) cannot load in the network-denied sandbox — the ambient Kit charts cover charting. Host catalog and prewired components are NOT in island scope (they live in the host page): compose them in the tree, and inside an island use only the ambient Kit and your own local components. This holds even when a host catalog component matches the visualization — inside an island, its ambient Kit equivalent (LineChart, BarChart, DonutChart, Sparkline, Progress) is the correct choice.
- Islands call host tools directly with the ambient tools API: \`const result = await tools.<tool_name>(args)\`, where <tool_name> is a HOST TOOLS name written as a LITERAL member access — never tools[expr], never aliasing or passing \`tools\` around. args must match that tool's (input: …) sketch exactly — field names, nesting, AND units: a money field marked (integer cents) takes minor units, so a dollar amount the user typed or a form collected is multiplied by 100 before the call (e.g. $25 → amount: 2500, fmt.money(2500) renders $25.00); sending the raw dollar number to a cents field moves 100× less money than the user asked. The sandbox has NO network — fetch/XHR/WebSocket are blocked by CSP; the ambient tools API is the only way an island reads or acts. A read tool resolves with the tool's output. A MUTATING tool pauses at the user approval gate: the call resolves {status:"pending-approval"} and its effect lands after the user approves — render a pending/awaiting-approval state, never treat it as a failure. An island can only reach the tools its own source literally names.
- Data honesty holds inside islands: every number or row an island renders comes from its props (bound to a tool reference) or from an ambient tools read — never hand-typed. A labeled field whose value is empty renders an em dash (—) in the value position — never a bare label with nothing after it.
- Empty data must never crash an island. A tool read can resolve with an empty array, an absent field, or undefined on a fresh account — so default every list before you use it (\`const rows = Array.isArray(result) ? result : []\` when the tool's shape IS the array, or \`Array.isArray(result?.<field>) ? result.<field> : []\` when TOOL RESPONSE SHAPES names that field — never assume a \`.data\` envelope that shape doesn't show) and never call .map/.length/.reduce on a value that might not be an array. Render a short, specific empty state (or defer to a Kit component, which already does) instead of throwing.`;

/** Re-gate 2026-07-26 I5-C — the money-unit annotation for one input field.
 *  The unit lives in the property DESCRIPTION ("Amount to send in cents…"),
 *  which the sketch used to drop entirely, so an island model sent the
 *  user's dollar number to a cents field ($25 → amount: 25 = $0.25). */
const unitAnnotation = (field: string, schema: Record<string, unknown> | null | undefined): string => {
  const description = typeof schema?.description === "string" ? schema.description : "";
  const cents = /cents$/i.test(field) || /\bcents\b|\bminor units?\b/i.test(description);
  const dollars = /\bdollars\b/i.test(description);
  // Contradictory metadata (a *cents field DESCRIBED as dollars) teaches
  // nothing — annotating either way would be a coin flip, and the runtime
  // guard skips such fields for the same reason (call.ts, review 2026-07-26).
  if (cents && dollars) return "";
  if (cents) return " (integer cents)";
  if (dollars) return " (dollars)";
  return "";
};

/** A one-line sketch of a tool's INPUT (top-level fields, one nesting level
 *  deep). Without it the model guesses arg shapes: a live island called a
 *  body-nested tool with flat args, the host route read an empty JSON body,
 *  and the approved mutation ran on defaults. Money fields carry their unit
 *  (see unitAnnotation). */
const toolInputSketch = (inputSchema: Record<string, unknown> | undefined): string => {
  const properties = inputSchema?.properties;
  if (typeof properties !== "object" || properties === null) return "";
  const fields = Object.entries(properties as Record<string, unknown>).map(([field, schema]) => {
    const child = (schema as Record<string, unknown> | null)?.properties;
    if (typeof child === "object" && child !== null) {
      const nested = Object.entries(child as Record<string, unknown>)
        .map(([name, nestedSchema]) => `${name}${unitAnnotation(name, nestedSchema as Record<string, unknown> | null)}`);
      return `${field}: {${nested.join(", ")}}`;
    }
    return `${field}${unitAnnotation(field, schema as Record<string, unknown> | null)}`;
  });
  return fields.length === 0 ? "" : ` (input: {${fields.join(", ")}})`;
};

/** The tools a query may name, and the shape cards the model must bind
 *  against. Without the tool list the model invents tool names; without
 *  shapes it binds blind (the broken-chart class). */
export const hostToolSections = (deps: GenerationDependencies): GenerationPromptSection[] => [
  ...(deps.tools === undefined || deps.tools.length === 0 ? [] : [{
    id: "catalog" as const,
    content: `HOST TOOLS (the ONLY tools a binding — inline reference or <Query> — or an action may name; anything else is a validation error). Every call's args MUST match the tool's (input: …) sketch exactly — same field names, same nesting (a field shown as {body: {…}} means the args object carries a "body" object), and same UNITS: a field marked (integer cents) takes minor units — multiply a user-typed dollar amount by 100 (e.g. $25 → 2500) and send a whole number; a field marked (dollars) takes the dollar amount itself. Never send the raw dollar number to a cents field:\n${deps.tools.map(({ name, description, risk, inputSchema }) => `- ${name} [${risk}]${toolInputSketch(inputSchema)}: ${description}`).join("\n")}`,
  }]),
  ...(deps.toolShapes === undefined || Object.keys(deps.toolShapes).length === 0 ? [] : [{
    id: "catalog" as const,
    content: `TOOL RESPONSE SHAPES (bind only to fields that exist; a binding outside these shapes fails validation). NEVER assume an envelope: each shape below is EXACTLY what that tool returns at the top level. A tool shown as "X[]" returns the array itself — bind it directly, with NO property first (rows={host_listInvoices({})}, not rows={host_listInvoices({}).data} — there is no ".data" unless the shape literally shows a "data" field). Only add a property when the shape below literally names it as a field (e.g. a shape written as "{ data: X[], total: number }" really has a "data" field, so THAT tool's rows are .data). Field annotations mark semantics: :money.cents = integer CENTS (bind the RAW number into Money cents / a format:"money" column — never pre-format it), :money.dollars = whole dollars, :date.iso and :date.epoch = machine dates (DateTime / format:"date"), :enum(a|b) = closed vocabulary (EnumBadge), :id = OPAQUE host identifier (for action payloads — NEVER invent, guess, or abbreviate an id value; when a call would need an id you don't literally have, use the un-filtered list variant instead), :percent.ratio = 0..1, :percent.0-100 = whole percent. A money field a host already signs (a credit or other liability account's balance arrives negative) sums AS-IS across every row a total is meant to cover: sum(accounts, "balance") over checking, savings, AND credit rows together is the correct total — never filter a row out by its kind, never wrap the field in Math.abs(), and never subtract a second query by hand to "apply" a sign the data already carries.\n${Object.entries(deps.toolShapes).map(([tool, shape]) => `- ${tool}: ${describeShapeWithSemantics(shape, deps.semantics?.[tool] ?? {})}`).join("\n")}`,
  }, {
    id: "catalog" as const,
    content: `RESHAPES AND CALCULATIONS — a binding is a read, a bounded RESHAPE of what it read, or a CALCULATION over it, and all three are function calls with the VALUE FIRST and quoted field names after. Reshapes: pick, rename, asPoints, format — nothing else, ever: no groupBy, no filter, no map, and never a bare ".length" property, which does not exist on a binding. Calculations: sum, count, average, min, max, difference, days_until, group_by. PREFER native field-name props over reshapes: components read RAW tool rows directly — Select takes the raw object array plus labelField/valueField, DataTable/CardList columns resolve dot-path keys ({key:"client.name"}), Kit charts read raw rows via data + xKey + series. Never pre-project rows a component can read raw.
- Need a COUNT of rows for a Stat or number (e.g. "12 issues")? Use count, never ".length": value={count(issues_list({}))}. Need a total/average/min/max of one numeric field across rows? Every aggregate NAMES its field, rows first: value={sum(invoices_list({}), "amountCents")} format="money". There is one sum, one average, one min, one max and one count; "avg" does not exist.
- Only a HOST prop whose schema declares [{label, value}] items takes asPoints: points={asPoints(revenue.rows, "month", "revenue")}. Kit charts read raw rows and never need it.
FORMAT for DISPLAY — money from host tools is integer CENTS, and dates are raw ISO/epoch; a bare number or ISO string shown to the user is a defect, on EVERY host. The Kit formats for you — USE it: <Money cents={...}/> and <DateTime value={...}/> for single values, DataTable/CardList column/field format tokens ("money", "date") for rows, <EnumBadge value={...}/> for enum fields. Cents money ALWAYS rides the Kit (<Money cents={...}/>, a format:"money" column) — never route a cents field through a legacy slot. When another such field must show through a LEGACY slot (Text value, legacy Table column, legacy Stat value, Badge label), a format(...) call is mandatory. format(...) turns a value into a STRING, so it is ONLY for text the user reads, NEVER for data a component computes on:
- format(...) on a legacy text/label slot: dates value={format(invoice.dueDate, "date")}, or a legacy Table column in place: rows={format(invoices, "dueDate", "date")}. Percents (0..1): format(value, "percent"). Plain numbers: format(value, "number"). Whole-dollar (non-cents) amounts: format(value, "currency").
- One way or the other is NOT optional: EVERY date/timestamp field and EVERY cents money field the user sees must ride a Kit semantic component / format token (dates in a legacy slot may carry a format step instead). A raw ISO string like 2026-07-21T17:00:00-07:00 or raw cents like 285000 on screen is a defect.
- NEVER format a value bound into a CHART or visualization component — anything that draws from numbers (a *Chart/*Donut/*Graph/*Plot host component, or its slices/series/points/segments/data/values prop), an <Island>, or an aggregate (sum/average/asPoints). Those need the RAW numeric field; a chart or total fed formatted STRINGS computes NaN and draws nothing. Example: for a spending donut + a table off the same query, bind slices={spending} (raw — no ".data" unless the shape shows one) and give the DataTable the same raw rows with a format:"money" column — never bind pre-formatted strings into the donut.
NEVER bind a raw object or array into a Text body, a Stat value, a Badge label, or a Table cell — it renders as raw JSON like {"received":3,"total":6} and fails validation. Reach the nested SCALAR instead: a DataTable/CardList dot-path column key ({key:"assignedTo.name"}, {key:"progress.received"}), or bind the specific scalar field ({dashboard.nearestDeadline.clientName}). Otherwise exclude the object column via columns=[...scalar keys].`,
  }]),
];
