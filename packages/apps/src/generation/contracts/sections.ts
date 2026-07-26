/**
 * Shared prompt sections — the pieces every generation contract (create,
 * exemplar-led create, edit, instant paint) composes from: role lines, the
 * clock, component styling, the catalog/theme/design-rules trio, the host
 * tool/shape/domain sections, the generated COMPONENTS section, and the
 * island contract.
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  describeShapeWithSemantics,
  kitPrompt,
  ISLAND_AMBIENT_KIT_NAMES,
  type NormalizedCatalog,
} from "@vendoai/core";
import { pinComponentName, type PinBaseline } from "../../pins.js";
import { prewiredSchemaPrompt } from "../../prewired-schema.js";
import type { GenerationDependencies } from "../engine.js";

const catalogPrompt = (catalog: NormalizedCatalog): string => JSON.stringify(
  catalog.map(({ name, description, propsJsonSchema, examples }) => ({
    name,
    whenToUse: description,
    propsJsonSchema: propsJsonSchema ?? null,
    examples: examples ?? [],
  })),
  null,
  2,
);

const pinBaselinesPrompt = (baselines: readonly PinBaseline[] = []): string => JSON.stringify(
  baselines.map((baseline) => ({
    slot: baseline.slot,
    componentName: pinComponentName(baseline.slot),
  })),
  null,
  2,
);

export interface GenerationPromptSection {
  id: "role" | "tree-contract" | "clock" | "component-styling" | "catalog" | "theme" | "design-rules" | "remixable-slots" | "prewired-props";
  content: string;
}

export const composePromptSections = (sections: readonly GenerationPromptSection[]): string => sections
  .map(({ content }) => content.trim())
  .filter((content) => content.length > 0)
  .join("\n\n");

/** The app's name is its panel display title. Echoing the ask back ("Create a
 *  chat dashboard that displays the user's…") ships a truncated sentence as
 *  the title of every fresh install's first app, so the cap is a validation
 *  gate, not just prompt guidance: an over-long name routes to repair with
 *  the message below. Create-only — stored apps with long names keep editing
 *  fine (the edit path never re-validates the name). */
export const APP_NAME_MAX_CHARS = 40;

export const generationPromptSections = (deps: GenerationDependencies): GenerationPromptSection[] => [{
  id: "role",
  content: "You are the Vendo app generation engine. Return JSON only, with no markdown.",
}, {
  id: "tree-contract",
  content: `TREE CONTRACT (vendo-genui/v2):
- At rest the app is {name, description?, tree, components?}; never emit id, server, secrets, egress, storage, or authority.
- tree.formatVersion is "vendo-genui/v2" and tree contains root, nodes, optional data and queries. Generated component sources live at the DOCUMENT level in components — the tree itself never carries them.
- Maximums: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} generated components, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per generated component source, ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes of generated-component source in total.
- Reserved prewired primitive names: ${RESERVED_COMPONENT_NAMES.join(", ")}.
- Every node is exactly {id, component, source?, props?, children?}. "component" is a REQUIRED non-empty string on EVERY node, including layout containers — use a prewired primitive (e.g. Stack, Row, Grid) as the component for containers; children is an array of node ids. Never emit a node without a component.
- "nodes" is a FLAT array of every node; nesting is expressed only through "children" id references, never by inlining child objects. "root" is the id of the top node.
- A node source is "prewired", "host", or "generated". Generated names are PascalCase, non-reserved, and require a document components[name] ESM React source.
- Prefer a host component whenever it covers the need. Matching the host brand is a hard goal.
- Prop bindings are exactly {"$path":"/json/pointer"} and {"$state":"clientStateKey"}. A query's result lives at "/" + its name.
- Queries are {name, tool, input?}; name is a bare identifier. Actions embedded in props are {action,payload?}.
- Query tools and action names are host tool names, or fn:<name> where name matches [A-Za-z_][A-Za-z0-9_-]*. A rung-1 tree cannot use fn: because it has no server.
`,
}, {
  // Without a clock the model guesses the year and hardcodes it into
  // filters/headers ("Top 10 in 2025" over 2026 data = a false empty state).
  // Computed per call, never cached.
  id: "clock",
  content: `CURRENT DATE: ${new Date().toISOString().slice(0, 10)} — this is "now" for the host's data. Resolve every relative period the user asks for ("this year", "this month", "next 90 days") from this date; never assume or hardcode a different year or period.`,
}, {
  id: "component-styling",
  content: `GENERATED COMPONENT STYLING:
- The component renders in a sandbox that sits directly on the host page's background (THEME TOKENS colors.background when provided; otherwise assume a light background). Never design for an imaginary dark backdrop; give the component's own containers explicit backgrounds.
- The host's brand tokens are available as CSS custom properties: --vendo-color-background, --vendo-color-surface, --vendo-color-text, --vendo-color-muted, --vendo-color-accent, --vendo-color-accent-text, --vendo-color-danger, --vendo-color-border, --vendo-font-family, --vendo-heading-family, --vendo-font-size, --vendo-radius-small/medium/large. Prefer them (e.g. color: "var(--vendo-color-text)") so the view matches the host brand.
`,
}, {
  id: "catalog",
  content: `HOST CATALOG (names, when-to-use guidance, props JSON schemas, and usage examples):\n${catalogPrompt(deps.catalog)}\nWhen a host catalog entry fits any part of the request, you MUST use a source:"host" node with its exact name and props schema; do not generate an equivalent component. Compose host, prewired, and generated nodes when needed.`,
}, {
  id: "theme",
  content: `THEME TOKENS:\n${JSON.stringify(deps.theme ?? null, null, 2)}`,
}, {
  id: "design-rules",
  content: `HOST DESIGN RULES:\n${(typeof deps.designRules === "function" ? deps.designRules() : deps.designRules)?.trim() || "(none provided)"}`,
}, {
  // Gesture-owned forking (2026-07-21): the fork is executed DETERMINISTICALLY
  // by the engine when the user acts on a remixable slot — the model never
  // decides to fork, so the edit dialect no longer teaches <ForkPin> (the op
  // keeps compiling for stored apps). This section teaches only what edits on
  // EXISTING forks need.
  id: "remixable-slots",
  content: (deps.pinBaselines ?? []).length === 0 ? "" : `REMIXABLE HOST SLOTS (slot -> the generated component a user fork ships under):
${pinBaselinesPrompt(deps.pinBaselines)}
- Forking a slot is a USER GESTURE the engine executes deterministically — never fork a slot yourself, and never copy or imitate captured host source in a new island.
- A slot the user has forked appears as the generated component named above (its pin is listed in APP_META.pins) with its full source in CURRENT_APP. Edit it like any island: re-declare <Island name="componentName">...complete updated source...</Island> with the SMALLEST change the instruction needs — keep the original structure, styling, behavior, and every comment intact (the fork is reviewed as a diff against the host's source; wholesale rewrites and stripped comments are review noise).
- Never remove or rename a pinned component, and never invent or alter baseline hashes.`,
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
- Empty data must never crash an island. A tool read can resolve with an empty array, an absent field, or undefined on a fresh account — so default every list before you use it (\`const rows = result.data ?? []\`) and never call .map/.length/.reduce on a value that might be undefined. Render a short, specific empty state (or defer to a Kit component, which already does) instead of throwing.`;

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
  // The domain manifest is FACT derived at sync, not guidance: it tells the
  // model what data exists at all, so an out-of-domain ask becomes an honest
  // disclaimer instead of a repurposed tool or invented figures.
  ...(deps.domains === undefined || (deps.domains.has.length === 0 && deps.domains.hasNot.length === 0) ? [] : [{
    id: "catalog" as const,
    content: `DATA DOMAINS (fact, derived from this host's tools — not guidance):${deps.domains.has.length === 0 ? "" : `\n- This host HAS data for: ${deps.domains.has.join(", ")}.`}${deps.domains.hasNot.length === 0 ? "" : `\n- This host has NO data for: ${deps.domains.hasNot.join(", ")}.`}
- An ask about a domain not covered above cannot be answered with real data: never repurpose an unrelated tool and never invent figures — cover the gap in the single "About this view" note (never per-tile prose).`,
  }]),
  ...(deps.toolShapes === undefined || Object.keys(deps.toolShapes).length === 0 ? [] : [{
    id: "catalog" as const,
    content: `TOOL RESPONSE SHAPES (bind only to fields that exist; a binding outside these shapes fails validation). Field annotations mark semantics: :money.cents = integer CENTS (bind the RAW number into Money cents / a format:"money" column — never pre-format it), :money.dollars = whole dollars, :date.iso and :date.epoch = machine dates (DateTime / format:"date"), :enum(a|b) = closed vocabulary (EnumBadge), :id = OPAQUE host identifier (for action payloads — NEVER invent, guess, or abbreviate an id value; when a call would need an id you don't literally have, use the un-filtered list variant instead), :percent.ratio = 0..1, :percent.0-100 = whole percent.\n${Object.entries(deps.toolShapes).map(([tool, shape]) => `- ${tool}: ${describeShapeWithSemantics(shape, deps.semantics?.[tool] ?? {})}`).join("\n")}`,
  }, {
    id: "catalog" as const,
    content: `RESHAPE PIPES — a binding may end with a bounded \`| op(...)\` pipe (this is the ONLY computation allowed in a binding). PREFER native field-name props over pipes: components read RAW tool rows directly — Select takes the raw object array plus labelField/valueField, DataTable/CardList columns resolve dot-path keys ({key:"client.name"}), Kit charts read raw rows via data + xKey + series. Never pre-project rows a component can read raw.
- Only a HOST prop whose schema declares [{label, value}] items takes asPoints: points={revenue.rows | asPoints(month, revenue)}. Kit charts read raw rows and never need it.
FORMAT for DISPLAY — money from host tools is integer CENTS, and dates are raw ISO/epoch; a bare number or ISO string shown to the user is a defect, on EVERY host. The Kit formats for you — USE it: <Money cents={...}/> and <DateTime value={...}/> for single values, DataTable/CardList column/field format tokens ("money", "date") for rows, <EnumBadge value={...}/> for enum fields. Cents money ALWAYS rides the Kit (<Money cents={...}/>, a format:"money" column) — never route a cents field through a legacy slot. When another such field must show through a LEGACY slot (Text value, legacy Table column, legacy Stat value, Badge label), a format(...) pipe is mandatory. format(...) turns a value into a STRING, so it is ONLY for text the user reads, NEVER for data a component computes on:
- format(...) on a legacy text/label slot: dates value={invoice.dueDate | format(date)}, or a legacy Table column in place: rows={invoices | format(dueDate, date)}. Percents (0..1): format(percent). Plain numbers: format(number). Whole-dollar (non-cents) amounts: format(currency).
- One way or the other is NOT optional: EVERY date/timestamp field and EVERY cents money field the user sees must ride a Kit semantic component / format token (dates in a legacy slot may carry a format step instead). A raw ISO string like 2026-07-21T17:00:00-07:00 or raw cents like 285000 on screen is a defect.
- NEVER format a value bound into a CHART or visualization component — anything that draws from numbers (a *Chart/*Donut/*Graph/*Plot host component, or its slices/series/points/segments/data/values prop), an <Island>, or a reshape aggregate (sum/avg/asPoints). Those need the RAW numeric field; a chart or total fed formatted STRINGS computes NaN and draws nothing. Example: for a spending donut + a table off the same query, bind slices={spending.data} (raw) and give the DataTable the same raw rows with a format:"money" column — never bind pre-formatted strings into the donut.
NEVER bind a raw object or array into a Text body, a Stat value, a Badge label, or a Table cell — it renders as raw JSON like {"received":3,"total":6} and fails validation. Reach the nested SCALAR instead: a DataTable/CardList dot-path column key ({key:"assignedTo.name"}, {key:"progress.received"}), or bind the specific scalar field ({dashboard.data.nearestDeadline.clientName}). Otherwise exclude the object column via columns=[...scalar keys].`,
  }]),
];
