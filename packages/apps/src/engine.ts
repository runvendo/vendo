import {
  KIT_WIRE_COMPONENT_NAMES,
  WIRE_COMPONENT_NAMES,
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT_V2,
  VendoError,
  compileWirePatchV2,
  compileWireV2,
  describeShapeWithSemantics,
  findDeprecatedReshapeUsage,
  kitPrompt,
  kitSpec,
  ISLAND_AMBIENT_KIT_NAMES,
  ISLAND_STRIPPED_SPECIFIERS,
  islandNetworkViolations,
  resolveIslandToolName,
  scanIslandTools,
  shapeAtPointer,
  stripIslandImports,
  printWireV2,
  isPathBinding,
  isStateBinding,
  validateAppDocument,
  validateTreeV2,
  type AppDocument,
  type DomainManifest,
  type NormalizedCatalog,
  type ShapeType,
  type ToolSemantics,
  type TreeNode,
  type TreeV2,
  type VendoTheme,
  type WireCompileResult,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import {
  actionFaults,
  endPass,
  extractEdit,
  literalDataFaults,
  regionParallelCreate,
  structuredRepair,
  type PipelineConfig,
  type PipelineContext,
  type PipelineEvent,
} from "./pipeline.js";
import { hasDefaultExport, pinComponentName, pinForkSource, type PinBaseline } from "./pins.js";
import { prewiredPropNames, prewiredSchemaPrompt } from "./prewired-schema.js";

/** The slice of a tool descriptor generation needs: prompt context and the
 *  query-tool existence check. `inputSchema` (W4 pipeline) feeds the
 *  structured-repair payload skeleton for mutation-without-payload fixes. */
export interface HostToolInfo {
  name: string;
  description: string;
  risk: string;
  inputSchema?: Record<string, unknown>;
}

/** v2 spec §§1,4 — a compiled prefix of the streaming wire: always a
 *  validateTreeV2-passing tree (valid-while-partial) plus the islands
 *  admitted so far. */
export interface GeneratedPartial {
  name?: string;
  tree: TreeV2;
  components?: Record<string, string>;
}

/** Speed lane (vendo-v2-speed) — structured create timing emitted per lane.
 *  `atMs` is milliseconds since the create() call began; `first-partial` fires
 *  when the first compiled prefix reaches the seam (time-to-paint) and
 *  `complete` when the lane's stream ends (with token usage). The full lane may
 *  repair up to 3× on validation failure, so it emits one `complete` per
 *  attempt — the LAST `full`/`complete` is the successful document; earlier
 *  ones are failed attempts. Opt-in: nothing is emitted unless `onTiming` is
 *  wired. */
export interface GenerationTimingEvent {
  lane: "paint" | "full" | "outline" | "section" | "repair" | "end-pass";
  phase: "first-partial" | "complete";
  atMs: number;
  thinking: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface GenerationDependencies {
  model: LanguageModel;
  /** The composition-normalized catalog (01 §14): propsJsonSchema is derived. */
  catalog: NormalizedCatalog;
  theme?: VendoTheme;
  /** Host design rules for the generation prompt. The function form is
   *  resolved every time prompt sections are built, so a per-call source
   *  (e.g. `.vendo/design-rules.md`) is re-read on each create/edit. */
  designRules?: string | (() => string | undefined);
  pinBaselines?: readonly PinBaseline[];
  /** v2 spec §3 — shape-card outputs keyed by tool; when present, create and
   *  edit compiles type-check bindings and surface shape-mismatch repair. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools queries may name. When present they are listed in the
   *  generation prompt and a query naming any other tool is a validation
   *  error routed to repair (verify-v2: the model invents tool names). */
  tools?: readonly HostToolInfo[];
  /** W3 (v3 spec §Context) — per-tool field semantics from
   *  `.vendo/semantics.json`: annotate the shape cards, drive Kit format
   *  defaults, and feed the law checks. Keyed by tool name. */
  semantics?: Readonly<Record<string, ToolSemantics>>;
  /** W3 — the host's domain manifest (has / has-NOT), surfaced to generation
   *  as fact so out-of-domain asks get a Disclaimer, never invented data. */
  domains?: DomainManifest;
  /** 06-apps §5 — additive, optional partial-tree streaming seam. */
  onPartial?: (partial: GeneratedPartial) => void | Promise<void>;
  /**
   * v2 spec §4 — the tier-0 paint lane. The lane runs only when a streaming
   * consumer (onPartial) is wired: the instant paint exists to reach a screen.
   * `model` is the no-think switch — point it at a thinking-disabled model
   * instance and the paint lane runs on it while the full lane keeps the main
   * model. `disabled` forces the single-lane flow.
   */
  paint?: {
    model?: LanguageModel;
    disabled?: boolean;
  };
  /** Speed lane — opt-in structured timing seam (see GenerationTimingEvent). */
  onTiming?: (event: GenerationTimingEvent) => void;
  /** W4 pipeline knobs (structured repair / region-parallel / end pass). */
  pipeline?: PipelineConfig;
  /** W4 pipeline — opt-in per-stage diagnostics (rounds, fallbacks, timing);
   *  nothing is emitted unless wired. */
  onPipeline?: (event: PipelineEvent) => void;
}

export interface GenerationCreateInput {
  prompt: string;
}

export interface GenerationEditInput {
  app: AppDocument;
  instruction: string;
  repairIssues?: string[];
}

export type GeneratedAppDocument = Omit<AppDocument, "id">;

/**
 * execution-v2 Wave 3 — the engine emits ONLY tree documents now. Server code
 * no longer rides a model "code edit" dialect: it is written BY the in-box
 * coding agent (box-agent.ts) during graduation, and the tree gains its `fn:`
 * bindings through this same tree-edit path afterward. The vestigial code
 * lane (rungs 2–4 file plans) is deleted.
 */
export type GenerationEditResult =
  | { kind: "document"; document: GeneratedAppDocument }
  | { kind: "failure"; issues: string[] };

/** 06-apps §5 — replaceable generation seam used by createApps(). */
export interface GenerationEngine {
  create(input: GenerationCreateInput, deps: GenerationDependencies): Promise<GeneratedAppDocument>;
  edit(input: GenerationEditInput, deps: GenerationDependencies): Promise<GenerationEditResult>;
}

// execution-v2 Wave 3 — the graduation judgment (instructionRequiresServer):
// UNAMBIGUOUS signals of the four machine reasons (scheduled/background work,
// third-party egress with secrets, heavy logic, app-owned state) — words that
// essentially never label a visible element.
const SERVER_INSTRUCTION = /\b(server|server-side|backend|database|persist|mutation|mutate|egress|schedule|scheduled|scheduling|cron|recurring)\b/i;
// Words that signal server work only OUTSIDE a visible-element label (ENG-349):
// "watch my invoices"/"email a daily digest" escalate, but "the digest card",
// "the watch list", "the API status card" stay on the cheap tree path.
const AMBIGUOUS_SERVER_TERM = /\b(api|http|web app|function|external|secret|digest|watch|monitor|daily|nightly|hourly|periodic)\b/gi;
const VISIBLE_ELEMENT_LABEL = /^(?:\w+\s+)?(card|button|badge|chip|header|heading|title|label|caption|text|list|table|column|row|cell|section|panel|chart|graph|icon|field|tab|menu|toolbar|sidebar|footer|banner|tile|widget)s?\b/i;
/** Wave 4 (layer 3) — asks whose UI needs exceed the tree: a real served web
 *  app, or interaction vocabulary (drag-and-drop, rich text) the tree's
 *  component walk cannot express. These are unambiguous — they never label a
 *  visible element. */
const SERVED_APP_INSTRUCTION = /\b(full web app|served web app|custom (?:ui|client|frontend)|drag[- ]?(?:and|&|'n')[- ]?drop|wysiwyg|rich[- ]text editor|ui:? ?http)\b/i;
/** Wave 4 — served-app words that can also LABEL a visible element ("make the
 *  kanban board heading blue" is a tree ask); same ENG-349 rule as the
 *  ambiguous server terms. */
const AMBIGUOUS_SERVED_TERM = /\b(kanban|whiteboard|draggable)\b/gi;
/** Wave 9 (escalation ladder, rung c) — UNAMBIGUOUS custom-code signals: real
 *  computation or bespoke logic no tool composition can express, so only a box
 *  (in-box agent writes server code) can serve the ask. */
const BOX_INSTRUCTION = /\b(custom (?:code|logic|parser|parsing|algorithm|scoring|dedup\w*)|write (?:a |an )?(?:parser|algorithm|script)|state machine|levenshtein|fuzzy[- ]?match\w*)\b/i;
/** Wave 9 — custom-code words that can also LABEL a visible element ("make the
 *  parse errors card blue", "show the ledger table"); same ENG-349 rule. */
const AMBIGUOUS_BOX_TERM = /\b(parse|parsing|parser|csv|xlsx|regex|algorithm|dedup\w*|de-dup\w*|reconcil\w*|ledger)\b/gi;
/** Wave 9 (rung b) — UNAMBIGUOUS per-run-judgment signals: each firing needs a
 *  model's call (who, which, what tone), but every effect is tool-reachable —
 *  the agentic automation run model, never a box. */
const AGENTIC_INSTRUCTION = /\b(decide|decides|deciding|judgment|judgement|discretion|deserv\w+|as appropriate|appropriately)\b/i;
/** Wave 9 — judgment words that can also LABEL a visible element ("rename the
 *  triage board"); same ENG-349 rule. */
const AMBIGUOUS_AGENTIC_TERM = /\b(triage|classify|prioriti[sz]e|assess|judge|escalate)\b/gi;
const reserved = new Set<string>(WIRE_COMPONENT_NAMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    source: baseline.source,
  })),
  null,
  2,
);

interface GenerationPromptSection {
  id: "role" | "tree-contract" | "clock" | "component-styling" | "catalog" | "theme" | "design-rules" | "remixable-slots" | "prewired-props";
  content: string;
}

const composePromptSections = (sections: readonly GenerationPromptSection[]): string => sections
  .map(({ content }) => content.trim())
  .filter((content) => content.length > 0)
  .join("\n\n");

const generationPromptSections = (deps: GenerationDependencies): GenerationPromptSection[] => [{
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
  // v4 (M9) — without a clock the model guesses the year and hardcodes it
  // into filters/headers ("Top 10 in 2025" over 2026 data = a false empty
  // state). Computed per call, never cached.
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
  id: "remixable-slots",
  content: `REMIXABLE HOST SLOTS:
${pinBaselinesPrompt(deps.pinBaselines)}
- A remixable slot is captured host source. To start editing it, emit <ForkPin slot="exact slot" into="parent-id" at={index} props={{...}}/> — the engine copies the trusted captured source into the named generated component (componentName above), renders it, and records the baseline pin. into/at/props are optional.
- After a slot is forked, edit its named generated component by re-declaring <Island name="componentName">...full source...</Island> while preserving the pin. Never reproduce or alter a baseline hash yourself.`,
}];

/** W3 — the COMPONENTS section is GENERATED from the component schemas
 *  (kitPrompt over the Kit specs + the legacy primitive signatures); no
 *  hand-written component list survives here. Deps-independent, so it is
 *  rendered once per process (perf budget: gen-scripted:create). */
let componentsPromptCache: string | undefined;
const componentsPromptSection = (): string => componentsPromptCache ??= `COMPONENTS (generated from the component schemas — use these EXACT component and prop names; an unknown prop is silently dropped and fails validation):

${kitPrompt({ only: [...KIT_WIRE_COMPONENT_NAMES] })}

# Legacy primitives (also available)
${prewiredSchemaPrompt()}`;

/** W4b §3 — the island contract, shared by the create and edit dialects. The
 *  "LAST RESORT" fear rules are retired (spec §format Islands): use the Kit
 *  when it covers the need (faster, branded); write an island for custom
 *  visuals/logic/interaction. Byte caps, the TSX + default-export gate, and
 *  the no-network CSP all stand. */
const islandContract = (): string => `- <Island name="PascalName">TSX with an \`export default\` component</Island> defines a generated component, referenced as <PascalName/> — plain source, never wrapped in braces, template literals, or fences. The island's name must be DISTINCT from every host catalog, Kit, and prewired component name (name resolution prefers those, so a colliding island never renders). Use a host catalog or Kit/prewired component when it covers the need (faster, brand-native); write an island for custom visuals, novel interactions, or client-side logic they cannot express (search-as-you-type, derived calculations, bespoke visualizations). Never put the whole app or its layout inside one island: compose regions so the app streams in progressively.
- Islands have NO import statements — everything is already in scope: React and its hooks (useState, useEffect, useMemo, useCallback, useRef), the entire Kit (${ISLAND_AMBIENT_KIT_NAMES.join(", ")}), and \`fmt\` value helpers (fmt.money(cents), fmt.dateTime(iso), fmt.percent(ratio), fmt.num(n)). Never write an import: known react/kit imports are stripped, and anything else (recharts, d3, lodash…) cannot load in the network-denied sandbox — the ambient Kit charts cover charting. Host catalog and prewired components are NOT in island scope (they live in the host page): compose them in the tree, and inside an island use only the ambient Kit and your own local components. This holds even when a host catalog component matches the visualization — inside an island, its ambient Kit equivalent (LineChart, BarChart, DonutChart, Sparkline, Progress) is the correct choice.
- Islands call host tools directly with the ambient tools API: \`const result = await tools.<tool_name>(args)\`, where <tool_name> is a HOST TOOLS name written as a LITERAL member access — never tools[expr], never aliasing or passing \`tools\` around. args must match that tool's (input: …) sketch exactly — field names AND nesting. The sandbox has NO network — fetch/XHR/WebSocket are blocked by CSP; the ambient tools API is the only way an island reads or acts. A read tool resolves with the tool's output. A MUTATING tool pauses at the user approval gate: the call resolves {status:"pending-approval"} and its effect lands after the user approves — render a pending/awaiting-approval state, never treat it as a failure. An island can only reach the tools its own source literally names.
- Data honesty holds inside islands: every number or row an island renders comes from its props (bound to a tool reference) or from an ambient tools read — never hand-typed.`;

/** v2 spec §2 — the JSX-wire create contract. The model emits markup, never
 *  JSON; the deterministic compiler owns ids, bindings, and validation. */
const wireContractSections = (deps: GenerationDependencies): GenerationPromptSection[] => [{
  id: "role",
  content: "You are the Vendo app generation engine. Return ONLY vendo-genui/v2 wire markup: a single <App> element. No prose, no markdown fences, no JSON.",
}, {
  id: "tree-contract",
  content: `WIRE DIALECT (vendo-genui/v2):
- Emit exactly one <App name="..."> element containing the whole app. No HTML/JSX comments anywhere — emit only elements. Positional nesting expresses the tree; NEVER emit id attributes — the compiler mints stable ids.
- DATA comes from INLINE TOOL REFERENCES written directly in a prop: rows={host_listTransactions({limit:20}).data} or value={host_getBudgets({}).totalCents} — the tool call (exact HOST TOOLS name + an args object, {} when none) followed by the field path. The compiler turns each distinct call into one fetch; IDENTICAL call+args used twice is ONE fetch, so reuse the same expression for the same data. Explicit <Query id="name" tool="tool_name" input={{...}}/> declarations (bound as {name.field.path}) are also accepted.
- Call args (and query inputs) are LITERAL JSON only — never put a reference/binding inside an args object: one call's input can NOT come from another call's result (the runtime executes inputs literally). When a tool needs an id you don't have literally, prefer the no-arg/list variant of the ask, or build the dependent lookup inside an <Island> using ambient tools.
- Attribute values: "string", {42}, {true}, bare attribute for true, {{...}} objects, {[...]} arrays, and data bindings. A binding is ONE inline tool call plus a plain field path (or a declared query name plus a field path) — NO other computation: no arithmetic, no .filter/.map/.length, no bracket indexing (address array elements with dot-numeric segments, e.g. {host_listAccounts({}).data.0.sparkline}), no string concatenation, no chained or nested calls. If a value would need computing, bind the closest raw field instead and let the component render it. There is NO string interpolation: never write a binding inside a \"string\" attribute — bind the whole prop to one {reference} or use separate Text nodes.
- Components resolve host catalog -> built-in components (the Kit and legacy primitives in the COMPONENTS section below) -> your <Island> components; the host brand wins a name collision.
- COMPOSE the app from host catalog and built-in components bound to query data. Prefer a host catalog component whenever it covers the need, with its exact name and props schema; use the Kit (DataTable/Stat/Money/DateTime/charts) and layout primitives for everything else. Matching the host brand is a hard goal.
- Never hardcode business data (invoices, balances, metrics, rows). Every number, label, and row the user sees must come from a tool binding (inline reference or <Query>); if no tool provides it, leave the region out rather than inventing data. This applies to CHARTS and METRICS too: when NO host tool supplies the numbers, render an honest empty-state (a short Text/Badge that the data isn't available), never fabricated, placeholder, or example figures.
- Actions are on* attributes naming a host tool or fn:<name> (name matches [A-Za-z_][A-Za-z0-9_-]*), e.g. onClick="host_tool" or onRun="fn:submit". A rung-1 app has no server, so never use fn: on create.
- An action that CHANGES host state (a write/destructive tool) MUST carry a payload binding the context it acts on — the per-row id for a row action, the form field values for a submit — e.g. onClick={{action:"host_send_reminder", payload:{invoiceId: invoices.rows.0.id}}}. Never wire a submit/primary Button to a read-only tool, and never leave a submit/primary Button with no action: a button that does nothing is a fake affordance. When NO host tool can perform the requested action, do NOT render a dead Submit — render an honest disclaimer (Text/Badge) saying the action isn't available on this host.
${islandContract()}
- Maximums: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} islands, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per island, ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes of island source total.`,
}, {
  id: "prewired-props",
  content: componentsPromptSection(),
}, ...hostToolSections(deps),
...generationPromptSections(deps).filter(({ id }) =>
  id === "clock" || id === "component-styling" || id === "catalog" || id === "theme" || id === "design-rules")];

/** W4b — a one-line sketch of a tool's INPUT (top-level fields, one nesting
 *  level deep). Without it the model guesses arg shapes: the live P3 island
 *  called a body-nested tool with flat args, the host route read an empty
 *  JSON body, and the approved mutation ran on defaults. */
const toolInputSketch = (inputSchema: Record<string, unknown> | undefined): string => {
  const properties = inputSchema?.properties;
  if (typeof properties !== "object" || properties === null) return "";
  const fields = Object.entries(properties as Record<string, unknown>).map(([field, schema]) => {
    const child = (schema as Record<string, unknown> | null)?.properties;
    if (typeof child === "object" && child !== null) {
      return `${field}: {${Object.keys(child).join(", ")}}`;
    }
    return field;
  });
  return fields.length === 0 ? "" : ` (input: {${fields.join(", ")}})`;
};

/** verify-v2 fixes — the tools a query may name, and (v2 spec §3) the shape
 *  cards the model must bind against. Without the tool list the model invents
 *  tool names; without shapes it binds blind (the broken-chart class). */
const hostToolSections = (deps: GenerationDependencies): GenerationPromptSection[] => [
  ...(deps.tools === undefined || deps.tools.length === 0 ? [] : [{
    id: "catalog" as const,
    content: `HOST TOOLS (the ONLY tools a binding — inline reference or <Query> — or an action may name; anything else is a validation error). Every call's args MUST match the tool's (input: …) sketch exactly — same field names, same nesting (a field shown as {body: {…}} means the args object carries a "body" object):\n${deps.tools.map(({ name, description, risk, inputSchema }) => `- ${name} [${risk}]${toolInputSketch(inputSchema)}: ${description}`).join("\n")}`,
  }]),
  // W3 — the domain manifest is FACT derived at sync, not guidance: it tells
  // the model what data exists at all, so an out-of-domain ask becomes an
  // honest disclaimer instead of a repurposed tool or invented figures.
  ...(deps.domains === undefined || (deps.domains.has.length === 0 && deps.domains.hasNot.length === 0) ? [] : [{
    id: "catalog" as const,
    content: `DATA DOMAINS (fact, derived from this host's tools — not guidance):${deps.domains.has.length === 0 ? "" : `\n- This host HAS data for: ${deps.domains.has.join(", ")}.`}${deps.domains.hasNot.length === 0 ? "" : `\n- This host has NO data for: ${deps.domains.hasNot.join(", ")}.`}
- An ask about a domain not covered above cannot be answered with real data: render an honest empty-state/disclaimer for that part, never repurpose an unrelated tool and never invent figures.`,
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

const wireContract = (deps: GenerationDependencies): string =>
  composePromptSections(wireContractSections(deps));

// ---------------------------------------------------------------------------
// v4 create contract (spec 2026-07-20-vendo-v4-generation-wave) — single-voice
// sections, each principle stated once, worked exemplars spanning archetypes.
// Rules a validator catches are deliberately absent: the repair loop re-teaches
// them with the violation message when broken. Opt-in via pipeline.promptRewrite
// while the A/B against wireContract runs on dev prompts.
// ---------------------------------------------------------------------------

/** The fictional host used by the exemplars. Exported so the exemplar-validity
 *  test compiles every exemplar against these exact tools — a broken example
 *  teaches broken apps, so the examples are pinned by test. */
export const V4_EXEMPLAR_TOOLS: HostToolInfo[] = [
  {
    name: "acme_getReceivables", description: "Receivables summary.", risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "acme_listInvoices", description: "List invoices.", risk: "read",
    inputSchema: { type: "object", properties: { status: { type: "string" } } },
  },
  {
    name: "acme_sendReminder", description: "Email a payment reminder for one invoice.", risk: "write",
    inputSchema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
  },
  {
    name: "acme_payInvoice", description: "Pay one invoice from the default account. Moves money.", risk: "destructive",
    inputSchema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
  },
];

export const V4_EXEMPLARS: ReadonlyArray<{ title: string; request: string; wire: string; why: string }> = [{
  title: "A worklist",
  request: "which invoices are overdue and let me chase them",
  wire: `<App name="Overdue invoices">
  <Stack gap={5}>
    <Row gap={4}>
      <Stat label="Overdue total" value={acme_getReceivables({}).overdueTotalCents} format="money" tone="accent"/>
      <Stat label="Invoices overdue" value={acme_getReceivables({}).overdueCount}/>
      <Stat label="Oldest due" value={acme_getReceivables({}).oldestDueDate} format="date"/>
    </Row>
    <DataTable rows={acme_listInvoices({status:"overdue"}).data} sortBy="dueDate asc" searchable columns={[{key:"clientName",label:"Client"},{key:"amountCents",label:"Amount",format:"money",align:"end"},{key:"dueDate",label:"Due",format:"date"},{key:"status",label:"Status"}]} emptyState="No overdue invoices — nothing to chase."/>
    <Button label="Send reminder for the most overdue" onClick={{action:"acme_sendReminder", payload:{invoiceId: acme_listInvoices({status:"overdue"}).data.0.id}}}/>
    <BarChart data={acme_getReceivables({}).byMonth} xKey="month" series={["overdueCents"]} format="money" emptyState="No history to chart yet."/>
  </Stack>
</App>`,
  why: "The hero is the number the user came for; the table is the working surface; the action is wired to a real tool with its context bound into payload (it will pause for user approval); the chart supports; every value rides a formatting component; every label is true of its binding.",
}, {
  title: "An action flow where half the ask is impossible",
  request: "pay an invoice and set up autopay",
  wire: `<App name="Pay an invoice">
  <Stack gap={5}>
    <Island name="PayInvoicePanel">
export default function PayInvoicePanel() {
  const [invoices, setInvoices] = useState([]);
  const [invoiceId, setInvoiceId] = useState("");
  const [phase, setPhase] = useState("idle");
  useEffect(() => { tools.acme_listInvoices({ status: "open" }).then((r) => setInvoices(r.data)); }, []);
  const pay = async () => {
    setPhase("sending");
    const result = await tools.acme_payInvoice({ invoiceId });
    setPhase(result && result.status === "pending-approval" ? "awaiting" : "paid");
  };
  return (
    <div style={{ display: "grid", gap: 12, padding: 16, background: "var(--vendo-color-surface)", border: "1px solid var(--vendo-color-border)", borderRadius: 8 }}>
      <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
        <option value="">Choose an invoice…</option>
        {invoices.map((inv) => (
          <option key={inv.id} value={inv.id}>{inv.clientName} — {fmt.money(inv.amountCents)}</option>
        ))}
      </select>
      <button onClick={pay} disabled={invoiceId === "" || phase !== "idle"}>
        {phase === "awaiting" ? "Awaiting your approval…" : phase === "paid" ? "Paid" : "Pay invoice"}
      </button>
    </div>
  );
}
    </Island>
    <PayInvoicePanel/>
    <DataTable rows={acme_listInvoices({status:"open"}).data} columns={[{key:"clientName",label:"Client"},{key:"amountCents",label:"Amount",format:"money",align:"end"},{key:"dueDate",label:"Due",format:"date"}]} emptyState="No open invoices."/>
    <Disclaimer title="Autopay isn't available" reason="No tool on this host manages autopay, so it can't be set up here. Any open invoice can be paid above."/>
  </Stack>
</App>`,
  why: "The feasible half is BUILT (the hero is the form), the impossible half gets a plain disclaimer — never a dead control. The island does its own dependent lookup with ambient tools, renders the awaiting-approval state for the mutating call, and formats with fmt.",
}, {
  title: "A detail page",
  request: "show me my latest invoice in full",
  wire: `<App name="Latest invoice">
  <Stack gap={5}>
    <Row gap={3}>
      <Text variant="heading" text={acme_listInvoices({}).data.0.clientName}/>
      <EnumBadge value={acme_listInvoices({}).data.0.status}/>
    </Row>
    <Row gap={4}>
      <Stat label="Amount" value={acme_listInvoices({}).data.0.amountCents} format="money"/>
      <Stat label="Due" value={acme_listInvoices({}).data.0.dueDate} format="date"/>
      <Stat label="Invoice #" value={acme_listInvoices({}).data.0.number}/>
    </Row>
    <DataTable rows={acme_listInvoices({}).data.0.lineItems} columns={[{key:"description",label:"Item"},{key:"amountCents",label:"Amount",format:"money",align:"end"}]} emptyState="No line items on this invoice."/>
    <Button label="Send reminder" onClick={{action:"acme_sendReminder", payload:{invoiceId: acme_listInvoices({}).data.0.id}}}/>
  </Stack>
</App>`,
  why: "A detail page, not a dashboard: identity first (name + live status), the facts row, then the record's contents. Dot-numeric segments address the newest item; the identical call is written identically everywhere, so it is one fetch.",
}];

const v4Role = `<role>
You are the Vendo app generation engine, embedded in the host product. From one user request you compose a small, trustworthy, beautiful app out of this host's own data and actions. Emit exactly one <App name="..."> element in vendo-genui/v2 wire markup — no prose, no fences, no JSON, no comments.
</role>`;

const v4GreatApps = `<building_great_apps>
Work in this order:
1. Find the hero. Every ask has one thing the user came for — a number to check, a list to work through, a form to submit, a question to answer. Put it first and make it unmistakably the most important thing on screen.
2. Pick the shape that serves the ask: a dashboard answers "how are things?"; a worklist serves "what do I act on?"; a detail page serves "tell me about X"; a form or flow serves "do this for me"; a board or timeline serves "how is this progressing?"; a report serves "brief me". Not every ask is a dashboard — a message-composer's hero is the compose box.
3. Compose a hierarchy, not a pile. After the hero, add 2–4 supporting sections in descending order of usefulness. Give the hero and charts full width; group related small stats into one row; a section either fills its row or shares it evenly — never leave a lone card floating beside empty space.
4. Match density to the job. A glanceable digest gets a few big numbers; a working table gets compact rows, search, and filters. Pick one density per app and hold it.
5. Speak human. Titles say what the data actually is ("Checking balance", not "Total balance" over one account). Enum values render through EnumBadge. Every date, amount, and percent rides its Kit component so it formats itself.
6. Design the gaps. An empty query gets a written emptyState with a next step, never a blank region. A part of the ask no tool can serve gets a Disclaimer that says so plainly — placed where that part would have appeared, one per missing part, never one blanket note for the whole app — and the parts that ARE feasible still get built.
7. Choose charts by what the data says. Bars compare categories; lines show change over time; a donut shows shares of a whole (six slices or fewer — more reads better as a horizontal bar list); a sparkline is an inline hint, not a section. One chart per fact — never two visualizations of the same numbers.
8. Restraint is the brand. Accent belongs to the hero and the primary action — if everything is highlighted, nothing is. Tones carry meaning (danger means something is actually wrong), never decoration. Whitespace separates sections; it is structure, not waste.
9. Keep the details quiet. Right-align money and numbers in tables. Sentence case for labels and titles. Human-form timestamps unless the ask is an audit trail.
10. Wear the host's brand. Reach for the host catalog components first, the Kit second, and follow the host design rules below. The bar: the app looks like the host shipped it.
</building_great_apps>`;

const v4Principles = `<principles>
1. Real data only. Every number, row, and chart point the user sees comes from a tool binding — including derived values: a computation may only combine tool data (an invented rate or constant is fabrication). When no tool backs an ask, the Disclaimer is the correct output.
2. Claims tell the truth. Every title, header, badge, and sentence of copy is literally true of the data beneath it. When the data can't support the claim, change the words, not the data.
3. Actions are real and gated. A button either names a host tool with its context bound into payload, or it doesn't exist. Mutations pause for user approval — render that state. When no tool can perform the ask, say so plainly instead.
4. Brand-native. Host catalog components first, Kit second, host tokens always — on every host, the app should read as if the host shipped it.
</principles>`;

const v4Grammar = (): string => `<wire_grammar>
- One <App name="..."> contains the whole app. Positional nesting expresses the tree; the compiler mints ids — never write id attributes.
- Data binds inline: rows={host_listInvoices({limit:20}).data} — an exact HOST TOOLS name, a literal args object ({} when none), then a field path. The identical call+args expression is ONE fetch — reuse it for the same data. <Query id="name" tool="..." input={{...}}/> declarations (bound as {name.field.path}) also work.
- The field path goes through the tool's response envelope exactly as TOOL RESPONSE SHAPES declares it — when a shape shows {data: {...}}, the path is host_getClient({id:"..."}).data.name, never a guessed top-level field.
- A binding is one call plus a plain field path — components handle computation, sorting, and formatting. Address list items with dot-numeric segments: {host_listAccounts({}).data.0.name}. A binding may end with one bounded | op(...) pipe; the common need is display format on a legacy text slot: value={x.dueDate | format(date)} — Kit components format themselves and never need it, and cents money always rides the Kit (<Money cents={...}/>, a format:"money" column), never a legacy slot.
- Args are literal JSON: a call's input never comes from another call's result. For a dependent lookup, use an <Island> with ambient tools.
- Actions are on* attributes naming a host tool, with the context they act on bound into payload: onClick={{action:"host_sendReminder", payload:{invoiceId: host_listInvoices({}).data.0.id}}}.
- <Island name="PascalName"> holds TSX with an export default component, rendered in a sandboxed frame and referenced as <PascalName/>. Already in scope (write no imports): React and its hooks, the entire Kit (${ISLAND_AMBIENT_KIT_NAMES.join(", ")}), and fmt helpers (fmt.money(cents), fmt.dateTime(iso), fmt.percent(ratio), fmt.num(n)).
- Host catalog components render on the host page — use them as tree nodes. An island's sandbox has only the ambient Kit: inside island source, the Kit equivalent is the correct choice (a host component name there can never render).
- Islands read and act ONLY through the ambient tools API — await tools.host_listInvoices({}), the tool name as a literal member access, args matching the tool's (input: …) sketch. There is no network. A mutating call resolves {status:"pending-approval"} and its effect lands after the user approves — render an awaiting-approval state.
- Island styling (until the utility sheet ships): inline styles over the host tokens — var(--vendo-color-background|surface|text|muted|accent|accent-text|danger|border), var(--vendo-font-family), var(--vendo-radius-small|medium|large). The frame sits on the host page's light background.
- Compose regions in the tree so the app streams in — an island is one region, never the whole app.
- Limits: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} islands, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per island.
</wire_grammar>`;

const v4Examples = (): string => `<examples>
Three complete apps for a FICTIONAL billing host. Its acme_* tools are NOT available to you — bind only the HOST TOOLS listed above. Study the shape, not the tools.

${V4_EXEMPLARS.map(({ title, request, wire, why }) => `<example>
${title}. Request: "${request}"

${wire}

Why this is right: ${why}
</example>`).join("\n\n")}
</examples>`;

/** v4 — charts preamble carried with the components section (the historical
 *  $NaN class: a chart fed formatted strings draws nothing). */
const V4_COMPONENTS_PREAMBLE = "Charts and visualizations read RAW numeric fields — their format prop handles display. Money is integer cents end-to-end; the Kit formats it.";

export const wireContractV4 = (deps: GenerationDependencies): string => composePromptSections([
  { id: "role", content: v4Role },
  { id: "tree-contract", content: v4GreatApps },
  { id: "tree-contract", content: v4Grammar() },
  { id: "tree-contract", content: v4Principles },
  { id: "prewired-props", content: `<components>\n${V4_COMPONENTS_PREAMBLE}\n\n${componentsPromptSection()}\n</components>` },
  {
    id: "catalog",
    content: `<host>\n${composePromptSections([
      ...hostToolSections(deps),
      ...generationPromptSections(deps).filter(({ id }) =>
        id === "catalog" || id === "theme" || id === "design-rules" || id === "clock"
        || (deps.pinBaselines !== undefined && deps.pinBaselines.length > 0 && id === "remixable-slots")),
    ])}\n</host>`,
  },
  { id: "prewired-props", content: v4Examples() },
]);

/** Contract selection for the create lanes (full, paint, section): the v4
 *  rewrite rides pipeline.promptRewrite while the A/B is measured. */
const createContract = (deps: GenerationDependencies): string =>
  deps.pipeline?.promptRewrite === true ? wireContractV4(deps) : wireContract(deps);

/** v2 spec §4 — the tier-0 lane emits a complete, fully-WIRED generic app
 *  immediately; the full lane then upgrades it in place by stable id. */
const tier0Contract = (deps: GenerationDependencies): string => `${createContract(deps)}

PAINT PASS (tier-0): emit a complete, minimal, fully-wired GENERIC app for the request RIGHT NOW.
- Catalog components with conservative default props; real inline tool references (or <Query> declarations) for the most relevant read tools so live data flows immediately.
- NO <Island> code islands — catalog and prewired components only.
- Keep it small (well under 40 nodes) and generic; a full-quality pass will replace it subtree-by-subtree, so favor a stable, conventional layout over cleverness.`;

/** The compact tier-0 structure the full lane is conditioned on: minted id +
 *  component per node, in document order, so the full lane can keep the
 *  layout ordering (and therefore the minted ids) stable for in-place
 *  hot-swap. */
const layoutHeader = (compiled: WireCompileResult): string =>
  compiled.tree.nodes.map((node) => `${node.id}:${node.component}`).join(" ");

/** Models wrap output in prose or a markdown fence despite instructions
 *  (the deleted v1 JSON path had the same tolerance). The wire is
 *  everything from the first `<App` through the last `</App>` (or stream
 *  end while it is still open) — deterministic, so prefix compiles stay
 *  valid-while-partial. */
const extractWire = (text: string): string => {
  const start = text.indexOf("<App");
  if (start === -1) return text;
  const closeTag = "</App>";
  const close = text.lastIndexOf(closeTag);
  return close === -1 ? text.slice(start) : text.slice(start, close + closeTag.length);
};

/** W3 Part 3 (W1 Exp1 verdict: ADOPT) — the production compile options:
 *  inline tool refs ON everywhere the engine compiles model wire (the
 *  registry names enable single-segment production tool heads); `<Query>`
 *  declarations stay accepted unchanged. */
const wireCompileOptionsFor = (
  deps: GenerationDependencies,
  hostComponents: readonly string[],
): Parameters<typeof compileWireV2>[1] => ({
  hostComponents,
  inlineRefs: true,
  ...(deps.tools === undefined ? {} : { inlineTools: deps.tools.map(({ name }) => name) }),
  ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
});

/** Stream the wire, compiling each accumulated prefix (throttled) into a
 *  valid-while-partial tree for the onPartial seam. */
const streamWire = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
  hostComponents: readonly string[],
  timing?: { lane: GenerationTimingEvent["lane"]; thinking: boolean; startedAt: number },
): Promise<{ compiled?: WireCompileResult; raw?: string; issues: string[] }> => {
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAt = 0;
  let firstPartialAt = 0;
  const pending: Promise<void>[] = [];
  const reportTiming = (phase: "first-partial" | "complete", usage?: { inputTokens?: number; outputTokens?: number }): void => {
    if (deps.onTiming === undefined || timing === undefined) return;
    deps.onTiming({ lane: timing.lane, phase, atMs: Date.now() - timing.startedAt, thinking: timing.thinking, ...(usage === undefined ? {} : { usage }) });
  };
  const flush = (): void => {
    if (deps.onPartial === undefined) return;
    if (firstPartialAt === 0) { firstPartialAt = Date.now(); reportTiming("first-partial"); }
    lastFlushAt = Date.now();
    const compiled = compileWireV2(extractWire(text), wireCompileOptionsFor(deps, hostComponents));
    const partial: GeneratedPartial = {
      tree: compiled.tree,
      ...(compiled.name === undefined ? {} : { name: compiled.name }),
      ...(Object.keys(compiled.components).length === 0 ? {} : { components: compiled.components }),
    };
    pending.push(Promise.resolve(deps.onPartial(partial)).catch(() => undefined));
  };
  const schedule = (): void => {
    if (deps.onPartial === undefined) return;
    const remaining = Math.max(0, 100 - (Date.now() - lastFlushAt));
    if (lastFlushAt === 0 || remaining === 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      flush();
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, remaining);
    }
  };
  const finishPartials = async (): Promise<void> => {
    // A throttled flush may still be pending at stream end — deliver it so
    // the last pre-final prefix reaches the seam before the final document.
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      flush();
    }
    await Promise.all(pending);
  };
  try {
    const { streamText } = await import("ai");
    const result = streamText({
      model: deps.model,
      system,
      prompt,
      temperature: 0,
      maxRetries: 0,
    });
    for await (const delta of result.textStream) {
      text += delta;
      schedule();
    }
    await finishPartials();
    if (deps.onTiming !== undefined && timing !== undefined) {
      const usage = await Promise.resolve(result.usage).catch(() => undefined);
      reportTiming("complete", usage === undefined ? undefined : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
    return { compiled: compileWireV2(extractWire(text), wireCompileOptionsFor(deps, hostComponents)), raw: extractWire(text), issues: [] };
  } catch (error) {
    await finishPartials();
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

/** verify-v2 fixes — models wrap island TSX in a JSX template-literal
 *  expression (`{`…`}`) despite instructions; strip it deterministically,
 *  the way {@link extractWire} strips fences. */
const ISLAND_WRAPPER = /^\{\s*`([\s\S]*)`\s*\}$/;
const normalizeIslandSource = (source: string): string => {
  const trimmed = source.trim();
  const match = ISLAND_WRAPPER.exec(trimmed);
  return match === null ? trimmed : (match[1] as string).trim();
};

/** TSX syntax gate for island sources. esbuild loads lazily (same pattern as
 *  the "ai" import); when unavailable the syntax check is skipped and the
 *  default-export check still applies.
 *
 *  The magic comments below are bundler directives, not runtime code — Node
 *  ignores them and this stays a plain dynamic import (proven: still works
 *  under Vitest's vm-sandboxed test runner, unlike a `new Function`-built
 *  indirection, which throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING there).
 *  `webpackIgnore`/`turbopackIgnore` tell the bundler to skip resolving this
 *  specific specifier at build time instead of walking into esbuild's
 *  package — which is where the real damage happens: esbuild's own
 *  lib/main.js resolves its native binary with a dynamic require, and once a
 *  bundler is inside esbuild's module graph at all, it tries to parse the
 *  platform binary and its README.md as JS and hard-fails the build.
 *  Confirmed empirically: without these comments (or `serverExternalPackages:
 *  ["esbuild"]` in the host's next.config), `next build` on a host importing
 *  "@vendoai/vendo/server" fails with "Unknown module type" /
 *  "invalid utf-8 sequence" on esbuild's platform binary; with them, the
 *  same host builds clean with esbuild left OUT of `serverExternalPackages`
 *  entirely (corpus-triage Task 10). */
const esbuildTransform = (async () => {
  try {
    const esbuild = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "esbuild");
    return (source: string) => void esbuild.transformSync(source, { loader: "tsx" });
  } catch {
    return undefined;
  }
})();

/** Every module specifier an island source imports — static (`import … from`,
 *  side-effect `import "x"`, `export … from`), dynamic `import("x")`, and
 *  `require("x")`. The jail's sucrase loader rewrites all of these to its
 *  require table, so any specifier here that is not an island-resolvable
 *  module (`ISLAND_STRIPPED_SPECIFIERS`) cannot resolve at runtime. */
const IMPORT_SPECIFIER =
  /(?:\bimport\b|\bexport\b)[^'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const islandImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

const ISLAND_RESOLVABLE_MODULE_SET = new Set<string>(ISLAND_STRIPPED_SPECIFIERS);

/** W4b — one island through the ambient contract: normalize the wrapper,
 *  silently strip the known react/kit imports (pretraining habit), gate the
 *  rest, and infer the tool manifest from the literal `tools` member chains
 *  (validated against the live registry when the host supplied one). */
interface PreparedIslands {
  /** name → stripped canonical source. Empty record when there are no islands. */
  components: Record<string, string>;
  /** name → sorted registry tool names its source reaches (may be empty). */
  componentTools: Record<string, string[]>;
  issues: string[];
}

/** verify-v2 fixes + W4b — a broken island must never persist: it renders as
 *  a contained error instead of an app. Checked at create AND edit, routed to
 *  repair. An island reaching for a module the ambient scope cannot provide
 *  error-boxes the whole app (verify-v2 #5: `recharts`), so a disallowed
 *  import is rejected before the syntax gate; computed/aliased `tools` access
 *  and unknown tool names are rejected before they can reach the runtime. */
const prepareIslands = async (
  rawComponents: Record<string, string>,
  tools: readonly HostToolInfo[] | undefined,
  hostComponents: readonly string[] = [],
): Promise<PreparedIslands> => {
  const issues: string[] = [];
  const components: Record<string, string> = {};
  const componentTools: Record<string, string[]> = {};
  const knownTools = tools === undefined ? undefined : new Set(tools.map((tool) => tool.name));
  // Host catalog + prewired components render in the HOST page — they can
  // never cross into the opaque-origin jail, so an island JSX tag naming one
  // is a guaranteed ReferenceError (live P4: <MapleSpendingDonut/>). Names
  // the ambient Kit also provides are fine — the Kit version renders.
  const ambientNames = new Set<string>(ISLAND_AMBIENT_KIT_NAMES);
  const hostOnlyNames = [...new Set([...hostComponents, ...RESERVED_COMPONENT_NAMES])]
    .filter((componentName) => !ambientNames.has(componentName));
  // W3 (#432) — name resolution is host catalog → built-ins → islands, so an
  // island NAMED after any of those never renders: the built-in wins and the
  // island is dead weight. Reject the name itself → repair to a distinct one.
  const unreachableIslandNames = new Set<string>([
    ...hostComponents,
    ...RESERVED_COMPONENT_NAMES,
    ...KIT_WIRE_COMPONENT_NAMES,
  ]);
  const transform = await esbuildTransform;
  for (const [name, rawSource] of Object.entries(rawComponents)) {
    if (unreachableIslandNames.has(name)) {
      issues.push(`island "${name}" would never render — component names resolve host catalog → built-ins (Kit/prewired) → islands, so "${name}" always resolves to the built-in/host component instead. Rename the island to a distinct PascalCase name.`);
    }
    const stripped = stripIslandImports(normalizeIslandSource(rawSource));
    issues.push(...stripped.issues.map((issue) => `island "${name}" ${issue}`));
    const source = stripped.source.trim();
    components[name] = source;
    if (!hasDefaultExport(source)) {
      issues.push(`island "${name}" must be plain TSX with an \`export default\` component — no braces, template literals, or fences around the source`);
      continue;
    }
    const disallowed = [...new Set(islandImportSpecifiers(source))].filter((specifier) => !ISLAND_RESOLVABLE_MODULE_SET.has(specifier));
    if (disallowed.length > 0) {
      issues.push(`island "${name}" imports ${disallowed.map((specifier) => `"${specifier}"`).join(", ")} — islands have NO imports; React, the Kit components (including the ambient Kit charts), fmt, and tools are already in scope, and nothing else can load in the network-denied sandbox. Remove the import and use the ambient names.`);
      continue;
    }
    const hostTags = hostOnlyNames.filter((componentName) =>
      new RegExp(`<\\s*${componentName}\\b`).test(source)
      // A locally-declared component of the same name is the island's own
      // (review): the local binding wins inside the jail, so don't reject it.
      && !new RegExp(`\\b(?:function|const|let|var|class)\\s+${componentName}\\b`).test(source));
    if (hostTags.length > 0) {
      issues.push(`island "${name}" renders ${hostTags.map((tag) => `<${tag}>`).join(", ")} — host catalog and prewired components exist only in the host page and can never load inside an island. Compose them in the TREE, or use the ambient Kit inside the island (${ISLAND_AMBIENT_KIT_NAMES.join(", ")}).`);
    }
    // The jail has no network: a habit-written fetch/XHR dies silently at the
    // CSP, so catch it here and repair to the ambient tools API instead.
    for (const api of islandNetworkViolations(source)) {
      issues.push(`island "${name}" calls ${api}(…) — an island has no network (the sandbox blocks fetch/XHR/WebSocket); the ambient tools API is the ONLY way to read or act: \`await tools.<tool_name>(args)\` with a HOST TOOLS name.`);
    }
    // The ambient tools contract: literal member access only, every chain
    // resolved against the live registry, the result stamped as the island's
    // entire runtime tool surface.
    const scan = scanIslandTools(source);
    issues.push(...scan.violations.map((violation) => `island "${name}" ${violation}`));
    const manifest = new Set<string>();
    for (const path of scan.paths) {
      if (knownTools === undefined) {
        manifest.add(path.join("_"));
        continue;
      }
      const resolved = resolveIslandToolName(path, knownTools);
      if (resolved === null) {
        issues.push(`island "${name}" calls unknown tool "tools.${path.join(".")}" — the host tools are: ${[...knownTools].join(", ")}`);
      } else {
        manifest.add(resolved);
      }
    }
    componentTools[name] = [...manifest].sort();
    if (transform === undefined) continue;
    try {
      transform(source);
    } catch (error) {
      issues.push(`island "${name}" is not valid TSX: ${error instanceof Error ? error.message.split("\n")[0] : "syntax error"}`);
    }
  }
  return { components, componentTools, issues };
};


/** Conservative kind check between a bound field's shape and the host prop's
 *  declared JSON-schema type: only CLEAR mismatches flag (an array of objects
 *  where number[] is expected renders an empty chart — the verify-v2 class);
 *  unknown shapes/schemas stay silent. */
const shapeSchemaMismatch = (shape: ShapeType, schema: Record<string, unknown>): string | null => {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === undefined || shape.kind === "json") return null;
  if (type === "array") {
    if (shape.kind !== "array") return `expected an array, the bound field is ${shape.kind}`;
    const items = schema.items;
    return isRecord(items) ? shapeSchemaMismatch(shape.items, items) : null;
  }
  if (type === "number" || type === "integer") {
    return shape.kind === "number" ? null : `expected a number, the bound field is ${shape.kind}`;
  }
  if (type === "string") return shape.kind === "string" ? null : `expected a string, the bound field is ${shape.kind}`;
  if (type === "boolean") return shape.kind === "boolean" ? null : `expected a boolean, the bound field is ${shape.kind}`;
  if (type === "object") return shape.kind === "object" ? null : `expected an object, the bound field is ${shape.kind}`;
  return null;
};

/** verify-v2 fixes — with tool shapes AND the catalog's prop schemas both in
 *  hand, a top-level `$path` prop on a host node can be kind-checked end to
 *  end. Existence is shape-check.ts's job; this catches the type mismatches
 *  that render silently broken (empty chart, blank stat). */
const bindingKindIssues = (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
): string[] => {
  if (deps.toolShapes === undefined) return [];
  const issues: string[] = [];
  const queryTool = new Map((compiled.tree.queries ?? []).map((query) => [query.name, query.tool]));
  const hostSchemas = new Map(deps.catalog.map((component) => [component.name, component.propsJsonSchema]));
  for (const node of compiled.tree.nodes) {
    if (node.source !== "host" || node.props === undefined) continue;
    const schema = hostSchemas.get(node.component);
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
    if (properties === undefined) continue;
    for (const [prop, value] of Object.entries(node.props)) {
      if (!isPathBinding(value)) continue;
      const [, queryName = "", ...rest] = value.$path.split("/");
      const tool = queryTool.get(queryName);
      const toolShape = tool === undefined ? undefined : deps.toolShapes[tool];
      if (toolShape === undefined) continue;
      const bound = shapeAtPointer(toolShape, rest.length === 0 ? "" : `/${rest.join("/")}`);
      if (bound === undefined) continue;
      const propSchema = properties[prop];
      if (!isRecord(propSchema)) continue;
      const mismatch = shapeSchemaMismatch(bound, propSchema);
      if (mismatch !== null) {
        issues.push(`node "${node.id}" prop "${prop}" binds ${value.$path}: ${mismatch} — bind a field whose shape matches the component's prop type`);
      }
    }
  }
  return issues;
};

/** W3 (live-verify finding) — asPoints/asOptions produce generic
 *  {label,value}/{value,label} items; a HOST prop whose schema declares its
 *  OWN item field names cannot read them (the Maple donut drew $NaN). The
 *  raw rows are the legal binding — reject the reshape at compile. */
const GENERIC_ITEM_RESHAPES = new Set(["asPoints", "asOptions"]);
const hostReshapeIssues = (compiled: WireCompileResult, deps: GenerationDependencies): string[] => {
  const issues: string[] = [];
  const hostSchemas = new Map(deps.catalog.map((component) => [component.name, component.propsJsonSchema]));
  for (const node of compiled.tree.nodes) {
    if (node.source !== "host" || node.props === undefined) continue;
    const schema = hostSchemas.get(node.component);
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
    if (properties === undefined) continue;
    for (const [prop, value] of Object.entries(node.props)) {
      if (!isPathBinding(value)) continue;
      const reshape = (value as unknown as { $reshape?: Array<{ op?: string }> }).$reshape;
      if (!Array.isArray(reshape) || !reshape.some((step) => GENERIC_ITEM_RESHAPES.has(step?.op ?? ""))) continue;
      const propSchema = properties[prop];
      const items = isRecord(propSchema) && isRecord(propSchema.items) ? propSchema.items : undefined;
      const itemProperties = items !== undefined && isRecord(items.properties) ? Object.keys(items.properties) : [];
      if (itemProperties.length === 0) continue;
      if (itemProperties.includes("label") && itemProperties.includes("value")) continue;
      issues.push(`node "${node.id}" prop "${prop}" reshapes with asPoints/asOptions, but host component "${node.component}" declares its own item fields (${itemProperties.join(", ")}) — it cannot read generic {label, value} items. Bind the RAW rows (drop the reshape) so the component receives the fields its schema names.`);
    }
  }
  return issues;
};

/** W3 law 2 (live-verify finding) — a query input executes as LITERAL JSON:
 *  the runtime never resolves bindings inside it, so a dependent call
 *  (`accountId: accounts.data.0.id`) reaches the tool as an unresolved
 *  binding object and the app ships broken. Reject at compile → repair. */
const queryInputIssues = (tree: TreeV2): string[] => {
  const issues: string[] = [];
  const findBinding = (value: unknown): boolean => {
    if (isPathBinding(value) || isStateBinding(value)) return true;
    if (Array.isArray(value)) return value.some(findBinding);
    if (isRecord(value)) return Object.values(value).some(findBinding);
    return false;
  };
  for (const query of tree.queries ?? []) {
    if (query.input !== undefined && findBinding(query.input)) {
      issues.push(`query "${query.name}" (tool "${query.tool}") embeds a binding in its input — query inputs must be LITERAL JSON the tool can execute directly; another query's result can never feed a query input. Use a literal value (or drop the optional input), or build the dependent lookup inside an <Island> with ambient tools.`);
    }
  }
  return issues;
};

/** W3 law 1 raw typing — probe values per shape kind, parsed against the Kit
 *  prop's zod schema. Kind-level only: a string-shaped field bound into
 *  Money.cents fails (pre-formatted money strings never reach a numeric
 *  slot); unknown shapes stay silent. */
const KIND_PROBES: Partial<Record<ShapeType["kind"], unknown>> = {
  string: "probe",
  number: 1,
  boolean: true,
  array: [],
  object: {},
};

const KIT_WIRE_SET: ReadonlySet<string> = new Set(KIT_WIRE_COMPONENT_NAMES);

const kitSlotIssues = (compiled: WireCompileResult, deps: GenerationDependencies): string[] => {
  if (deps.toolShapes === undefined) return [];
  const issues: string[] = [];
  const queryTool = new Map((compiled.tree.queries ?? []).map((query) => [query.name, query.tool]));
  for (const node of compiled.tree.nodes) {
    if (node.source === "host" || node.source === "generated" || node.props === undefined) continue;
    if (!KIT_WIRE_SET.has(node.component)) continue;
    const spec = kitSpec(node.component);
    if (spec === undefined) continue;
    for (const [prop, value] of Object.entries(node.props)) {
      if (!isPathBinding(value) || "$reshape" in (value as unknown as Record<string, unknown>)) continue;
      const propSpec = spec.props[prop];
      if (propSpec === undefined) continue;
      const [, queryName = "", ...rest] = value.$path.split("/");
      const tool = queryTool.get(queryName);
      const shape = tool === undefined ? undefined : deps.toolShapes[tool];
      if (shape === undefined) continue;
      const bound = shapeAtPointer(shape, rest.length === 0 ? "" : `/${rest.join("/")}`);
      if (bound === undefined || bound.kind === "json" || bound.kind === "null") continue;
      const probe = KIND_PROBES[bound.kind];
      if (probe === undefined) continue;
      if (!propSpec.schema.safeParse(probe).success) {
        issues.push(`node "${node.id}" prop "${prop}" on <${node.component}> binds ${value.$path}, a ${bound.kind} field, but this slot takes a different RAW type (${propSpec.doc}) — bind the raw field with that type (e.g. the integer-cents field, not a pre-formatted display string).`);
      }
    }
  }
  return issues;
};

/** verify-v2 fixes — models write "Total: {metric.total}" inside STRING
 *  attributes; the wire has no string interpolation, so the braces render
 *  literally. Any string prop embedding a declared query reference is a
 *  repair-routed error. */
const interpolationIssues = (compiled: WireCompileResult): string[] => {
  const queryNames = (compiled.tree.queries ?? []).map((query) => query.name);
  if (queryNames.length === 0) return [];
  const pattern = new RegExp(`\\{(?:${queryNames.join("|")})(?:\\.[A-Za-z0-9_]+)*\\}`);
  const issues: string[] = [];
  const walk = (nodeId: string, prop: string, value: unknown): void => {
    if (typeof value === "string") {
      if (pattern.test(value)) {
        issues.push(`node "${nodeId}" prop "${prop}" embeds a binding inside a string — string interpolation is unsupported; bind the prop to a single {reference} or split the text into separate Text nodes`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(nodeId, prop, item);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) walk(nodeId, prop, child);
    }
  };
  for (const node of compiled.tree.nodes) {
    for (const [prop, value] of Object.entries(node.props ?? {})) walk(node.id, prop, value);
  }
  return issues;
};

/** v2 create validation: the compile must be complete and clean, the tree
 *  catalog-consistent and renderable, islands syntactically sound, queries
 *  aimed at real host tools, bindings shape-checked, and the assembled
 *  document valid. */
const validateCompiledCreate = async (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
): Promise<{ document?: GeneratedAppDocument; issues: string[] }> => {
  const issues: string[] = [];
  if (!compiled.complete) issues.push("wire did not parse to a complete <App> document");
  issues.push(...compiled.issues.map(({ code, message }) => `wire ${code}: ${message}`));
  const name = compiled.name?.trim() ?? "";
  if (name === "") issues.push('App must carry a non-empty name="..." attribute');
  const prepared = await prepareIslands(compiled.components, deps.tools, deps.catalog.map(({ name: componentName }) => componentName));
  const components = Object.keys(prepared.components).length === 0 ? undefined : prepared.components;
  issues.push(...prepared.issues);
  if (deps.tools !== undefined) {
    const known = new Set(deps.tools.map((tool) => tool.name));
    for (const query of compiled.tree.queries ?? []) {
      if (!query.tool.startsWith("fn:") && !known.has(query.tool)) {
        issues.push(`query "${query.name}" names unknown tool "${query.tool}"; the host tools are: ${[...known].join(", ")}`);
      }
    }
  }
  issues.push(...compiled.bindingErrors.map((error) =>
    `binding ${error.path} on node "${error.nodeId}" prop "${error.prop}": ${error.message}${error.available === undefined ? "" : ` (available: ${error.available.join(", ")})`}`));
  issues.push(...bindingKindIssues(compiled, deps));
  issues.push(...kitSlotIssues(compiled, deps));
  issues.push(...hostReshapeIssues(compiled, deps));
  issues.push(...queryInputIssues(compiled.tree));
  issues.push(...interpolationIssues(compiled));
  issues.push(...await catalogIssues(compiled.tree, components, deps.catalog));
  // Law 1 is checkable only when a tool surface exists to trace data to —
  // a tool-less composition (fresh init, bare tests) has nothing to bind.
  if (deps.tools !== undefined && deps.tools.length > 0) {
    issues.push(...literalDataIssues(compiled.tree, deps.catalog));
  }
  issues.push(...actionIssues(compiled.tree, deps.tools));
  issues.push(...rootedRenderIssues(compiled.tree));
  if (issues.length > 0) return { issues };
  const document: GeneratedAppDocument = {
    format: VENDO_APP_FORMAT,
    name,
    ui: "tree",
    tree: structuredClone(compiled.tree) as unknown as NonNullable<AppDocument["tree"]>,
    ...(components === undefined ? {} : {
      components: structuredClone(components),
      // W4b §2 — the compiler-stamped per-island tool manifest (least
      // privilege: an island with no tools carries an explicit empty list).
      componentTools: structuredClone(prepared.componentTools),
    }),
  };
  const appValidation = validateAppDocument({ ...document, id: "app_generation_validation" });
  if (!appValidation.ok) return { issues: [appValidation.error.message] };
  return { document, issues: [] };
};

const withoutId = (app: AppDocument): GeneratedAppDocument => {
  const { id: _id, ...document } = structuredClone(app);
  return document;
};

const isActionBinding = (value: unknown): boolean =>
  isRecord(value) && typeof value.action === "string";

const isRuntimeBound = (value: unknown): boolean =>
  isPathBinding(value) || isStateBinding(value) || isActionBinding(value);

const standardIssuePath = (issue: unknown): Array<string | number> => {
  if (!isRecord(issue) || !Array.isArray(issue.path)) return [];
  return issue.path.flatMap((segment) => {
    const key = isRecord(segment) && "key" in segment ? segment.key : segment;
    return typeof key === "string" || typeof key === "number" ? [key] : [];
  });
};

const pathTargetsRuntimeBinding = (value: unknown, path: Array<string | number>): boolean => {
  let current = value;
  if (isRuntimeBound(current)) return true;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (isRecord(current)) {
      current = current[String(segment)];
    } else {
      return false;
    }
    if (isRuntimeBound(current)) return true;
  }
  return false;
};

const issueMessage = (issue: unknown): string => {
  if (isRecord(issue) && typeof issue.message === "string") return issue.message;
  return "props did not match the registered schema";
};

const hostPropsIssues = async (
  node: TreeNode,
  component: NormalizedCatalog[number],
): Promise<string[]> => {
  // 01 §14: schema-less entries validate permissively by design — the model
  // infers props and the entry carries no validator.
  if (component.propsSchema === undefined) return [];
  const props = node.props ?? {};
  try {
    const result = await component.propsSchema["~standard"].validate(props);
    if (!isRecord(result) || !Array.isArray(result.issues)) return [];
    return result.issues.flatMap((issue) => {
      const path = standardIssuePath(issue);
      if (pathTargetsRuntimeBinding(props, path)) return [];
      const location = path.length === 0 ? "" : ` at props.${path.join(".")}`;
      return [`node "${node.id}" props invalid for host component "${component.name}"${location}: ${issueMessage(issue)}`];
    });
  } catch (error) {
    return [`node "${node.id}" props validation failed for host component "${component.name}": ${error instanceof Error ? error.message : "unknown schema error"}`];
  }
};

/** Prewired primitives are handed to the model by name plus an exact prop
 *  signature (prewired-schema.ts). The compiler keeps any attribute the model
 *  writes, so a wrong name (`data` for Table's `rows`, `onPress` for Button's
 *  `onClick`) survives into props and the renderer silently ignores it — the
 *  "valid table, empty rows" class. Reject unknown prop names so the model
 *  repairs to the real one instead of shipping a dead component. */
const prewiredPropsIssues = (node: TreeNode): string[] => {
  const allowed = prewiredPropNames.get(node.component);
  const props = node.props;
  if (allowed === undefined || props === undefined) return [];
  return Object.keys(props)
    .filter((name) => !allowed.has(name))
    .map((name) => `node "${node.id}" sets unknown prop "${name}" on prewired component "${node.component}"; the renderer drops it. Allowed props: ${[...allowed].join(", ") || "(none)"}`);
};

const catalogIssues = async (
  tree: TreeV2,
  components: Record<string, string> | undefined,
  catalog: NormalizedCatalog,
): Promise<string[]> => {
  const hostCatalog = new Map(catalog.map((component) => [component.name, component]));
  const hostNames = new Set(hostCatalog.keys());
  const generatedNames = new Set(Object.keys(components ?? {}));
  const issues: string[] = [];
  for (const node of tree.nodes) {
    if (node.source === "host") {
      const component = hostCatalog.get(node.component);
      if (component === undefined) {
        issues.push(`node "${node.id}" references host component "${node.component}" absent from the catalog`);
      } else {
        issues.push(...await hostPropsIssues(node, component));
      }
    } else if (node.source === "prewired") {
      if (!reserved.has(node.component)) {
        issues.push(`node "${node.id}" references unknown prewired component "${node.component}"`);
      } else {
        issues.push(...prewiredPropsIssues(node));
      }
    } else if (node.source === "generated" && !generatedNames.has(node.component)) {
      issues.push(`node "${node.id}" references generated component "${node.component}" without source`);
    } else if (node.source === undefined) {
      // Legacy/direct trees can omit source; the renderer resolves the name to
      // a prewired primitive first, so a reserved name here gets the same
      // prop-name gate as an explicit source:"prewired" node — otherwise a
      // stored tree could still ship an ignored prop (e.g. Table.data).
      if (reserved.has(node.component)) {
        issues.push(...prewiredPropsIssues(node));
      } else if (!hostNames.has(node.component) && !generatedNames.has(node.component)) {
        issues.push(`node "${node.id}" references unknown component "${node.component}"`);
      }
    }
  }
  return issues;
};

/** Action-wiring honesty (verify-v2 #4 reminder, #6 intake). A mutating action
 *  with no payload has nothing to change; a submit button wired to a read tool
 *  or to nothing at all is a fake affordance. Each routes to repair, where the
 *  model binds the row/form context — or, when the host has no tool for the
 *  ask, replaces the dead button with an honest disclaimer. Detection lives in
 *  pipeline.ts (shared with the structured-repair fix space); this renders the
 *  repair-facing messages. */
const actionIssues = (tree: TreeV2, tools: readonly HostToolInfo[] | undefined): string[] =>
  actionFaults(tree, tools).map((fault) => {
    if (fault.kind === "dead-submit") {
      return `node "${fault.nodeId}" is a submit affordance ("${fault.label}") with no action — a submit that does nothing is a fake affordance. Wire its action to a host tool that performs it, binding the form/row context into payload; or if NO host tool can perform it, replace it with an honest disclaimer that the action isn't available.`;
    }
    if (fault.kind === "missing-payload") {
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes mutating tool "${fault.action}" with no payload — bind the context it acts on (a per-row id, or the form field values) into payload:{...} so the action has something to change.`;
    }
    if (fault.kind === "unknown-tool") {
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes unknown tool "${fault.action}" — law 2: an action must name a REAL host tool from the HOST TOOLS list (or fn:<name>). Pick the real tool, or render an honest disclaimer if the host has none.`;
    }
    if (fault.kind === "ungrounded-payload") {
      const unknown = fault.unknownFields ?? [];
      const missing = fault.missingFields ?? [];
      const parts = [
        ...(unknown.length === 0 ? [] : [`sends payload field(s) ${unknown.map((field) => `"${field}"`).join(", ")} the tool does not declare`]),
        ...(missing.length === 0 ? [] : [`omits the tool's REQUIRED input parameter(s) ${missing.map((field) => `"${field}"`).join(", ")}`]),
      ];
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes tool "${fault.action}" but ${parts.join(" and ")} — law 2: the payload must carry exactly the tool's real input parameters (${(fault.allowedFields ?? []).join(", ")}).`;
    }
    return `node "${fault.nodeId}" submit affordance ("${fault.label}") prop "${fault.prop}" is wired to read-only tool "${fault.action}" — a submit that only reads is a fake affordance. Wire it to a mutating host tool with a payload, or render an honest disclaimer if the host has none.`;
  });

/** W3 law 1 — hand-typed business data on a data-classed prop (Kit prop
 *  classes, legacy data props, host catalog schemas). Detection lives in
 *  pipeline.ts (shared with the structured-repair fix space). */
const literalDataIssues = (tree: TreeV2, catalog: NormalizedCatalog): string[] =>
  literalDataFaults(tree, catalog).map((fault) =>
    `node "${fault.nodeId}" prop "${fault.prop}" on <${fault.component}> carries hand-typed LITERAL business data — law 1: every data-classed prop must be a binding to a tool result, e.g. ${fault.prop}={queryName.field.path}. If NO host tool provides this data, render an honest <Disclaimer reason="..."/> instead — never invent figures.`);

export const distinctIssues = (current: string[], next: string[]): string[] => [
  ...new Set([...current, ...next]),
];

const insertChild = (parent: TreeNode, nodeId: string, index: unknown): void => {
  const children = parent.children ?? [];
  const position = typeof index === "number" && Number.isInteger(index)
    ? Math.max(0, Math.min(index, children.length))
    : children.length;
  children.splice(position, 0, nodeId);
  parent.children = children;
};

const rootedRenderIssues = (tree: TreeV2): string[] => {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const pending = [tree.root];
  const visited = new Set<string>();
  const issues: string[] = [];
  let hasRenderableContent = false;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node === undefined) {
      issues.push(`rooted node "${id}" is missing; persisted edits cannot rely on streaming placeholders`);
      continue;
    }
    if (node.source === "generated" || node.source === "host") {
      hasRenderableContent = true;
    } else if (node.component === "Text") {
      const text = node.props?.text;
      if (text !== undefined && text !== null && String(text).trim() !== "") hasRenderableContent = true;
    } else if (!new Set(["Stack", "Row", "Grid"]).has(node.component)) {
      hasRenderableContent = true;
    }
    pending.push(...(node.children ?? []));
  }
  if (!hasRenderableContent) {
    issues.push(`tree root "${tree.root}" renders an empty layout; keep at least one attached, visible node`);
  }
  return issues;
};

const validateEditedApp = async (
  app: AppDocument,
  deps: GenerationDependencies,
  source: AppDocument,
): Promise<string[]> => {
  const validation = validateAppDocument(app);
  if (!validation.ok) return [validation.error.message];
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT_V2) return ["tree edit produced an unsupported format"];
  const treeValidation = validateTreeV2(app.tree);
  if (!treeValidation.ok) return [treeValidation.error.message];
  const sourceTreeValidation = validateTreeV2(source.tree);
  // Filter EVERY per-node check against the pre-existing app the same way, so
  // an edit that doesn't touch a stale node (a legacy Table.data prop, an
  // already-dead button) is never blocked by that node's issue — only issues
  // the edit newly introduces surface. Ids are stable across an edit, so a
  // carried-over issue is a byte-identical string.
  const sourceRenderIssues = sourceTreeValidation.ok
    ? new Set(rootedRenderIssues(sourceTreeValidation.tree))
    : new Set<string>();
  const sourceCatalogIssues = sourceTreeValidation.ok
    ? new Set([
      ...await catalogIssues(sourceTreeValidation.tree, source.components, deps.catalog),
      ...literalDataIssues(sourceTreeValidation.tree, deps.catalog),
      ...actionIssues(sourceTreeValidation.tree, deps.tools),
    ])
    : new Set<string>();
  return [
    ...rootedRenderIssues(treeValidation.tree).filter((issue) => !sourceRenderIssues.has(issue)),
    ...(await catalogIssues(treeValidation.tree, app.components, deps.catalog)).filter((issue) => !sourceCatalogIssues.has(issue)),
    ...literalDataIssues(treeValidation.tree, deps.catalog).filter((issue) => !sourceCatalogIssues.has(issue)),
    ...actionIssues(treeValidation.tree, deps.tools).filter((issue) => !sourceCatalogIssues.has(issue)),
  ];
};

const repairPrompt = (issues: string[]): string =>
  issues.length === 0 ? "" : `\nREPAIR_THESE_ISSUES: ${JSON.stringify(issues)}`;

/** v2 spec §5 — the one-dialect edit contract: the model sees the app as
 *  id-anchored wire markup and emits ONE <Edit> patch in the same grammar.
 *  The JSON ops dialect is gone. */
const editContract = (deps: GenerationDependencies): string => composePromptSections([{
  id: "role",
  content: "You are the Vendo app edit engine. Return ONLY one vendo-genui/v2 <Edit>...</Edit> patch document. No prose, no markdown fences, no JSON.",
}, {
  id: "tree-contract",
  content: `EDIT DIALECT (vendo-genui/v2): patch the CURRENT_APP wire below against its id="..." anchors; never regenerate the whole app and never invent ids.
Ops (attribute-only elements unless noted):
- <Set id="node-id" attr=.../> merges attributes into the node's props. Same value forms as create: "string", {expr}, bare attribute for true, on*="host_tool"|"fn:name" actions, bindings {queryName.path | reshape(...)}.
- <Unset id="node-id" propName otherProp/> removes the named props.
- <Insert into="parent-id" at={index}>...new elements in the create grammar...</Insert> — omit at to append; the compiler mints ids for inserted nodes.
- <Remove id="node-id"/> removes the node and its subtree. The root cannot be removed.
- <Move id="node-id" into="parent-id" at={index}/> reparents/reorders.
- <Query id="name" tool="tool_name" input={{...}}/> adds or replaces a query; <RemoveQuery id="name"/> deletes it.
- <Island name="PascalName">raw TSX with a default export</Island> adds or replaces a generated component; <RemoveIsland name="PascalName"/> deletes it. Island rules:
${islandContract()}
- <SetName name="..."/> renames the app; <SetDescription text="..."/> sets its description.
- <ForkPin slot="exact remixable slot" into="parent-id" at={index} props={{...}}/> forks a remixable host slot (see REMIXABLE HOST SLOTS).
Emit at least one op. Keep patches minimal and local to the instruction.`,
}, ...generationPromptSections(deps).filter(({ id }) =>
  id === "clock" || id === "component-styling" || id === "catalog" || id === "theme" || id === "design-rules" || id === "remixable-slots")]);

/** Raw-text model call for the edit dialect (no streaming seam: edits are
 *  small and apply atomically). */
const generateWireText = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
): Promise<{ text?: string; issues: string[] }> => {
  try {
    const { streamText } = await import("ai");
    const result = streamText({
      model: deps.model,
      system,
      prompt,
      temperature: 0,
      maxRetries: 0,
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    return { text, issues: [] };
  } catch (error) {
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

/** The engine-policy half of <ForkPin> (v2 spec §5 extension op): copies the
 *  TRUSTED captured baseline into the named generated component, mints and
 *  attaches the node, and records the pin — the model never retypes source. */
const applyForkPin = (
  app: AppDocument,
  props: Record<string, unknown>,
  deps: GenerationDependencies,
): string[] => {
  const fail = (message: string): string[] => [`<ForkPin> failed: ${message}`];
  const slot = props.slot;
  if (typeof slot !== "string" || slot.length === 0) return fail("requires a non-empty slot attribute");
  const baseline = deps.pinBaselines?.find((candidate) => candidate.slot === slot);
  if (baseline === undefined) return fail(`pin baseline "${slot}" is unavailable`);
  if (app.pins?.some((pin) => pin.slot === baseline.slot)) return fail(`pin slot "${baseline.slot}" is already forked`);
  // ENG-348 — a named-export capture forks with a synthesized default export.
  const forkSource = pinForkSource(baseline.source);
  if (!hasDefaultExport(forkSource)) {
    return fail(`pin baseline "${slot}" has no default export and no detectable named component export; export the component from its module and re-run vendo sync`);
  }
  const componentName = pinComponentName(baseline.slot);
  if (app.components?.[componentName] !== undefined) return fail(`generated component "${componentName}" already exists`);
  const tree = app.tree as unknown as TreeV2;
  const parentId = props.into === undefined ? tree.root : props.into;
  if (typeof parentId !== "string") return fail("into must be a string node id when present");
  const parent = tree.nodes.find(({ id }) => id === parentId);
  if (parent === undefined) return fail(`parent "${parentId}" does not exist`);
  if (props.at !== undefined && (typeof props.at !== "number" || !Number.isInteger(props.at) || props.at < 0)) {
    return fail("at must be a non-negative integer when present");
  }
  // Compiler-owned id discipline: mint past the existing ordinals, exactly
  // like an <Insert> would.
  const key = componentName.toLowerCase();
  let ordinal = 0;
  for (const { id } of tree.nodes) {
    const match = /^([a-z][a-z0-9]*)-([1-9]\d*)$/.exec(id);
    if (match !== null && match[1] === key) ordinal = Math.max(ordinal, Number(match[2]));
  }
  const node: TreeNode = {
    id: `${key}-${ordinal + 1}`,
    component: componentName,
    source: "generated",
    ...(isRecord(props.props) ? { props: structuredClone(props.props) as TreeNode["props"] } : {}),
  };
  tree.nodes.push(node);
  insertChild(parent, node.id, props.at);
  app.components = { ...(app.components ?? {}), [componentName]: forkSource };
  app.pins = [...(app.pins ?? []), { slot: baseline.slot, base: baseline.hash }];
  return [];
};

const editTree = async (
  input: GenerationEditInput,
  deps: GenerationDependencies,
): Promise<GenerationEditResult> => {
  if (input.app.tree?.formatVersion !== VENDO_TREE_FORMAT_V2) {
    return { kind: "failure", issues: ["tree edits require a vendo-genui/v2 app"] };
  }
  const hostComponents = deps.catalog.map(({ name }) => name);
  const base = {
    tree: input.app.tree as unknown as TreeV2,
    components: input.app.components ?? {},
    name: input.app.name,
  };
  const context = printWireV2(base, { includeIds: true });
  let issues = [...(input.repairIssues ?? [])];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await generateWireText(
      deps,
      editContract(deps),
      `TASK: EDIT_TREE\nINSTRUCTION: ${input.instruction}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${context}\nAPP_META: ${JSON.stringify({ name: input.app.name, description: input.app.description ?? null, pins: input.app.pins ?? [] })}${repairPrompt(issues)}`,
    );
    issues = distinctIssues(issues, output.issues);
    if (output.text !== undefined) {
      const patched = compileWirePatchV2(extractEdit(output.text), base, {
        hostComponents,
        ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
        extensionOps: ["ForkPin", "SetDescription"],
      });
      const patchIssues = [
        ...(patched.complete ? [] : ["wire did not parse to a complete <Edit> document"]),
        ...patched.issues.map(({ code, message }) => `wire ${code}: ${message}`),
      ];
      if (patchIssues.length === 0) {
        const app: AppDocument = {
          ...structuredClone(input.app),
          ...(patched.name === undefined ? {} : { name: patched.name }),
          tree: structuredClone(patched.tree) as unknown as NonNullable<AppDocument["tree"]>,
        };
        // W4b — model islands go through the same ambient contract as create
        // (strip + tools scan + manifest restamp). PINNED components are
        // captured host source on the furnishing trust path: their real
        // imports resolve through the captured tables, so they are neither
        // stripped nor scanned — and get NO ambient-tools manifest.
        const pinnedNames = new Set((input.app.pins ?? []).map((pin) => pinComponentName(pin.slot)));
        const isPinned = ([componentName]: [string, string]) => pinnedNames.has(componentName);
        const splitIslands = (all: Record<string, string>) => ({
          pinned: Object.fromEntries(Object.entries(all).filter(isPinned)),
          model: Object.fromEntries(Object.entries(all).filter((entry) => !isPinned(entry))),
        });
        const patchedIslands = splitIslands(patched.components);
        const prepared = await prepareIslands(patchedIslands.model, deps.tools, hostComponents);
        // Pre-existing island issues never block an unrelated edit (same
        // filtering rule as catalog/action issues below).
        const sourcePrepared = await prepareIslands(splitIslands(input.app.components ?? {}).model, deps.tools, hostComponents);
        const sourceIslandIssues = new Set(sourcePrepared.issues);
        const islandIssues = prepared.issues.filter((issue) => !sourceIslandIssues.has(issue));
        const nextComponents = { ...patchedIslands.pinned, ...prepared.components };
        if (Object.keys(nextComponents).length === 0) {
          delete app.components;
          delete app.componentTools;
        } else {
          app.components = structuredClone(nextComponents);
          app.componentTools = structuredClone(prepared.componentTools);
        }
        const extensionIssues: string[] = [];
        const changed = patched.appliedOps > 0 || patched.extensionOps.length > 0;
        for (const extension of patched.extensionOps) {
          if (extension.op === "SetDescription") {
            if (typeof extension.props.text !== "string") {
              extensionIssues.push("<SetDescription> needs a string text attribute");
            } else {
              app.description = extension.props.text;
            }
            continue;
          }
          extensionIssues.push(...applyForkPin(app, extension.props, deps));
        }
        if (!changed) extensionIssues.push("the patch contained no effective ops; emit at least one op for the instruction");
        // A <ForkPin> in this patch may have added a pinned component after
        // the manifest restamp above. Keep componentTools DEFINED whenever
        // components exist, so the renderer's stamped-era rule (missing key
        // = zero tools) applies instead of the source-scan fallback (review).
        if (app.components !== undefined && app.componentTools === undefined) {
          app.componentTools = {};
        }
        if (extensionIssues.length === 0) {
          const validationIssues = [...islandIssues, ...await validateEditedApp(app, deps, input.app)];
          if (validationIssues.length === 0) {
            return { kind: "document", document: withoutId(app) };
          }
          issues = distinctIssues(issues, validationIssues);
        } else {
          issues = distinctIssues(issues, extensionIssues);
        }
      } else {
        issues = distinctIssues(issues, patchIssues);
      }
    }
  }
  return { kind: "failure", issues: issues.length === 0 ? ["tree edit failed validation"] : issues };
};

/**
 * Speed lane — page-open prewarm. Pays the provider import + TLS/keep-alive
 * connection cost up front with a throwaway 1-token generation so the first
 * real create reuses a live socket instead of opening one cold. Best-effort:
 * any failure (no key, offline) is swallowed. Measured effect on first-paint
 * is small (model time-to-first-token dominates), so this is a cheap
 * worst-case guard, not a headline win — see docs/verification/vendo-v2-speed.
 */
export const prewarmModels = async (models: readonly LanguageModel[]): Promise<void> => {
  const { generateText } = await import("ai");
  await Promise.all(
    models.map((model) => generateText({ model, prompt: "ok", maxOutputTokens: 1, maxRetries: 0 }).then(() => undefined).catch(() => undefined)),
  );
};

/** W5a (v3 spec §Dialect retirement) — compile INFO, never an error: a NEW
 *  create that emits a deprecated reshape op still compiles (stored apps
 *  depend on the ops), but each distinct usage logs one observable line so
 *  live traffic tells us when deletion is safe. */
const logDeprecatedDialect = (document: GeneratedAppDocument): GeneratedAppDocument => {
  for (const notice of findDeprecatedReshapeUsage(document.tree)) {
    console.info(`[vendo] INFO generated app "${document.name}" uses a ${notice} (kept compiling for stored apps; W5a staged retirement)`);
  }
  return document;
};

/** A provider-form designRules is resolved ONCE per create/edit, so the
 *  paint/retry/repair prompts within one generation never mix rule sets; the
 *  next generation re-resolves. */
const snapshotDesignRules = (deps: GenerationDependencies): GenerationDependencies =>
  typeof deps.designRules === "function" ? { ...deps, designRules: deps.designRules() } : deps;

/** 06-apps §§2,5; v2 spec §§2,4 — wire-backed rung-1 generation and
 *  two-dialect edit planning. */
export const modelEngine: GenerationEngine = {
  async create(input, rawDeps) {
    const deps = snapshotDesignRules(rawDeps);
    const startedAt = Date.now();
    const hostComponents = deps.catalog.map(({ name }) => name);
    const basePrompt = `TASK: CREATE_APP\nUSER_REQUEST: ${input.prompt}`;
    // W4 pipeline context: structured repair / region-parallel / end pass all
    // validate through the ONE create validator.
    const pipelineContext: PipelineContext = {
      deps,
      hostComponents,
      startedAt,
      validate: (compiled) => validateCompiledCreate(compiled, deps),
    };
    const finish = (document: GeneratedAppDocument): Promise<GeneratedAppDocument> =>
      endPass(document, input.prompt, pipelineContext).then(logDeprecatedDialect);
    // Tier-0 paint lane (v2 spec §4): only with a streaming consumer — the
    // instant paint exists to reach a screen. One attempt, no repair loop:
    // an invalid paint is simply not resident (the full lane still runs).
    let resident: GeneratedAppDocument | undefined;
    let residentLayout: string | undefined;
    if (deps.onPartial !== undefined && deps.paint?.disabled !== true) {
      const paintDeps = deps.paint?.model === undefined ? deps : { ...deps, model: deps.paint.model };
      const paint = await streamWire(paintDeps, tier0Contract(deps), basePrompt, hostComponents, { lane: "paint", thinking: false, startedAt });
      if (paint.compiled !== undefined) {
        const validated = await validateCompiledCreate(paint.compiled, deps);
        if (validated.document !== undefined) {
          resident = validated.document;
          residentLayout = layoutHeader(paint.compiled);
        }
      }
    }
    // The upgrade must never regress the painted surface: while the resident
    // tier-0 app is on screen, full-lane prefixes smaller than the resident
    // stay suppressed — the paint holds until the upgrade can replace it
    // whole (ids stay stable via the TIER0_LAYOUT conditioning).
    const residentNodes = resident === undefined
      ? 0
      : (resident.tree as unknown as TreeV2).nodes.length;
    const forward = deps.onPartial;
    const fullLaneDeps: GenerationDependencies = forward === undefined || residentNodes === 0
      ? deps
      : {
        ...deps,
        onPartial: (partial) => partial.tree.nodes.length < residentNodes ? undefined : forward(partial),
      };
    // W4 pipeline steps 1+3 — outline + region-parallel tier-2 (flagged).
    // Any planning/section/assembly failure falls through to the
    // single-stream loop below: parallel is an optimization, never a gate.
    if (deps.pipeline?.regionParallel === true) {
      const parallel = await regionParallelCreate(pipelineContext, {
        userRequest: input.prompt,
        generateSection: async (prompt) => {
          const output = await streamWire(
            // Section streams bypass onPartial (the assembled prefix is
            // emitted on section completion below) but keep the model/deps.
            { ...deps, onPartial: undefined },
            createContract(deps),
            prompt,
            hostComponents,
            { lane: "section", thinking: false, startedAt },
          );
          return output.raw;
        },
        ...(fullLaneDeps.onPartial === undefined ? {} : {
          emitPartial: (assembledWire: string) => {
            const compiled = compileWireV2(assembledWire, wireCompileOptionsFor(deps, hostComponents));
            if (compiled.tree.nodes.length < residentNodes) return;
            void Promise.resolve(fullLaneDeps.onPartial?.({
              tree: compiled.tree,
              ...(compiled.name === undefined ? {} : { name: compiled.name }),
              ...(Object.keys(compiled.components).length === 0 ? {} : { components: compiled.components }),
            })).catch(() => undefined);
          },
        }),
      });
      if (parallel.document !== undefined) return finish(parallel.document);
    }
    let issues: string[] = [];
    // W4 pipeline step 5 — structured repair budget: at most 2 strict rounds
    // per create, then today's free-form regeneration loop takes over.
    let repairRounds = deps.pipeline?.structuredRepair === false ? 0 : 2;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const output = await streamWire(
        fullLaneDeps,
        createContract(deps),
        `${basePrompt}${residentLayout === undefined
          ? ""
          : `\nTIER0_LAYOUT: ${residentLayout}\nAn instant paint pass already rendered that layout. Emit the full-quality app; keep the top-level component ordering compatible where reasonable so minted node ids stay stable and the upgrade swaps in place.`}${repairPrompt(issues)}`,
        hostComponents,
        { lane: "full", thinking: false, startedAt },
      );
      issues = distinctIssues(issues, output.issues);
      if (output.compiled !== undefined) {
        const validated = await validateCompiledCreate(output.compiled, deps);
        if (validated.document !== undefined) return finish(validated.document);
        issues = distinctIssues(issues, validated.issues);
        if (repairRounds > 0) {
          const repaired = await structuredRepair(output.compiled, input.prompt, pipelineContext, repairRounds);
          repairRounds -= repaired.rounds;
          if (repaired.document !== undefined) return finish(repaired.document);
          issues = distinctIssues(issues, repaired.issues);
        }
      }
    }
    // Never a white box: a failed full lane falls back to the resident
    // tier-0 app (v2 spec §4).
    if (resident !== undefined) return logDeprecatedDialect(resident);
    throw new VendoError("validation", "model could not produce a valid app", issues);
  },
  async edit(input, deps) {
    // execution-v2 Wave 3 — the engine only patches the tree. Server work is
    // the in-box agent's job (graduation, runtime.machine.editApp); the tree
    // gains its fn: bindings through this same tree-edit path afterward.
    return editTree(input, snapshotDesignRules(deps));
  },
};

/**
 * execution-v2 Wave 3 — the graduation judgment: whether an instruction needs
 * server capability (scheduled/background work, third-party egress, heavy
 * logic, app-owned state) and so must ride the in-box agent (runtime graduates
 * 1→2, delegates the server work to the box, then lands fn: bindings via the
 * tree-edit path). A false answer keeps the edit on the pure tree path.
 * Ambiguous words like "api" or "function" count only when they are not
 * labeling a visible element — "make the API status card blue" must stay on
 * the cheap tree path (ENG-349).
 */
export const instructionRequiresServer = (app: Pick<AppDocument, "ui">, instruction: string): boolean =>
  SERVER_INSTRUCTION.test(instruction)
  || SERVED_APP_INSTRUCTION.test(instruction)
  || app.ui === "http"
  || matchesOutsideElementLabel(instruction, AMBIGUOUS_SERVER_TERM);

/** The ENG-349 rule as a helper: an ambiguous term counts only when it is not
 *  labeling a visible element ("watch my invoices" escalates; "the watch list"
 *  stays on the cheap tree path). */
const matchesOutsideElementLabel = (instruction: string, term: RegExp): boolean =>
  [...instruction.matchAll(term)].some((match) =>
    !VISIBLE_ELEMENT_LABEL.test(instruction.slice(match.index + match[0].length).trimStart()));

/**
 * execution-v2 Wave 9 — the server-work ESCALATION LADDER (Yousef's economics
 * ruling: box graduation costs minutes of model round trips; the existing
 * automations engine covers most server-shaped needs in seconds). For a
 * server-shaped instruction the runtime prefers, in order:
 *
 *   (a) "steps"   — expressible as deterministic tool calls (host + connected
 *                   tools + existing fn: refs) with jsonata reshaping, forEach,
 *                   and park/resume approval gates. A steps automation on the
 *                   EXISTING automations engine; no machine.
 *   (b) "agentic" — needs per-run judgment, but every effect is tool-reachable.
 *                   An agentic automation (the agent-loop run model); no machine.
 *   (c) "box"     — only when actual custom code is required (real computation,
 *                   libraries, complex persistent state, non-tool-shaped egress,
 *                   latency-sensitive logic). Box graduation — EXPERIMENTAL,
 *                   gated by `experimentalMachines`.
 *
 * `null` means the instruction is not server-shaped at all (pure tree path).
 * Same judge shape as {@link instructionRequiresServer}: deterministic word
 * classes with the ENG-349 visible-element rule for ambiguous terms. A served
 * (ui: "http") app is always box-shaped — its whole surface lives in its
 * machine.
 */
export const serverWorkRung = (
  app: Pick<AppDocument, "ui">,
  instruction: string,
): "steps" | "agentic" | "box" | null => {
  if (app.ui === "http") return "box";
  if (BOX_INSTRUCTION.test(instruction) || matchesOutsideElementLabel(instruction, AMBIGUOUS_BOX_TERM)) {
    return "box";
  }
  if (AGENTIC_INSTRUCTION.test(instruction) || matchesOutsideElementLabel(instruction, AMBIGUOUS_AGENTIC_TERM)) {
    return "agentic";
  }
  return instructionRequiresServer(app, instruction) ? "steps" : null;
};

/**
 * execution-v2 Wave 4 — the 2→3 escalation judgment (same judge shape as
 * {@link instructionRequiresServer}): whether an instruction's UI needs exceed
 * the tree, so the box agent must build a REAL web app the machine serves
 * (layer 3, experimental — the runtime refuses this path unless the host
 * enabled `experimentalServedApps`). An already-served app is always a
 * layer-3 subject: every edit of it is served-app work.
 */
export const instructionRequiresServedApp = (
  app: Pick<AppDocument, "ui">,
  instruction: string,
): boolean =>
  app.ui === "http"
  || SERVED_APP_INSTRUCTION.test(instruction)
  || [...instruction.matchAll(AMBIGUOUS_SERVED_TERM)].some((match) =>
    !VISIBLE_ELEMENT_LABEL.test(instruction.slice(match.index + match[0].length).trimStart()));
