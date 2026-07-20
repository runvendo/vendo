import {
  PREWIRED_COMPONENT_NAMES,
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
  describeShape,
  JAIL_ALLOWED_MODULES,
  shapeAtPointer,
  printWireV2,
  isPathBinding,
  isStateBinding,
  validateAppDocument,
  validateTreeV2,
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
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
  designRules?: string;
  pinBaselines?: readonly PinBaseline[];
  /** v2 spec §3 — shape-card outputs keyed by tool; when present, create and
   *  edit compiles type-check bindings and surface shape-mismatch repair. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools queries may name. When present they are listed in the
   *  generation prompt and a query naming any other tool is a validation
   *  error routed to repair (verify-v2: the model invents tool names). */
  tools?: readonly HostToolInfo[];
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
const reserved = new Set<string>(PREWIRED_COMPONENT_NAMES);

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
  id: "role" | "tree-contract" | "component-styling" | "catalog" | "theme" | "design-rules" | "remixable-slots" | "prewired-props";
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
  content: `HOST DESIGN RULES:\n${deps.designRules?.trim() || "(none provided)"}`,
}, {
  id: "remixable-slots",
  content: `REMIXABLE HOST SLOTS:
${pinBaselinesPrompt(deps.pinBaselines)}
- A remixable slot is captured host source. To start editing it, emit <ForkPin slot="exact slot" into="parent-id" at={index} props={{...}}/> — the engine copies the trusted captured source into the named generated component (componentName above), renders it, and records the baseline pin. into/at/props are optional.
- After a slot is forked, edit its named generated component by re-declaring <Island name="componentName">...full source...</Island> while preserving the pin. Never reproduce or alter a baseline hash yourself.`,
}];

/** v2 spec §2 — the JSX-wire create contract. The model emits markup, never
 *  JSON; the deterministic compiler owns ids, bindings, and validation. */
const wireContractSections = (deps: GenerationDependencies): GenerationPromptSection[] => [{
  id: "role",
  content: "You are the Vendo app generation engine. Return ONLY vendo-genui/v2 wire markup: a single <App> element. No prose, no markdown fences, no JSON.",
}, {
  id: "tree-contract",
  content: `WIRE DIALECT (vendo-genui/v2):
- Emit exactly one <App name="..."> element containing the whole app. No HTML/JSX comments anywhere — emit only elements. Positional nesting expresses the tree; NEVER emit id attributes — the compiler mints stable ids.
- <Query id="queryName" tool="tool_name" input={{...}}/> declarations come FIRST inside <App>, before layout, so data fetching starts while the rest streams. A query result lives at the query's name; bind it into props with expressions like value={queryName} or value={queryName.field.path}.
- Attribute values: "string", {42}, {true}, bare attribute for true, {{...}} objects, {[...]} arrays, and query bindings {queryName.path.segments}. Bindings are PLAIN FIELD REFERENCES ONLY — no arithmetic, no function/method calls (.filter/.map/.length), no bracket indexing (address array elements with dot-numeric segments, e.g. {accounts.data.0.sparkline}), no string concatenation. If a value would need computing, bind the closest raw field instead and let the component render it. There is NO string interpolation: never write {reference} inside a \"string\" attribute — bind the whole prop to one {reference} or use separate Text nodes.
- Components resolve host catalog -> prewired primitives -> your <Island> components; the host brand wins a name collision. Prewired primitives: ${RESERVED_COMPONENT_NAMES.join(", ")}, Card, Button, Input, Select, Table, Badge, Stat, Tabs.
- COMPOSE the app from host catalog and prewired components bound to query data. Prefer a host catalog component whenever it covers the need, with its exact name and props schema; use Stat/Card/Table/Badge and layout primitives for everything else. Matching the host brand is a hard goal.
- Never hardcode business data (invoices, balances, metrics, rows). Every number, label, and row the user sees must come from a <Query> binding; if no tool provides it, leave the region out rather than inventing data. This applies to CHARTS and METRICS too: when NO host tool supplies the numbers, render an honest empty-state (a short Text/Badge that the data isn't available), never fabricated, placeholder, or example figures.
- Actions are on* attributes naming a host tool or fn:<name> (name matches [A-Za-z_][A-Za-z0-9_-]*), e.g. onClick="host_tool" or onRun="fn:submit". A rung-1 app has no server, so never use fn: on create.
- An action that CHANGES host state (a write/destructive tool) MUST carry a payload binding the context it acts on — the per-row id for a row action, the form field values for a submit — e.g. onClick={{action:"host_send_reminder", payload:{invoiceId: invoices.rows.0.id}}}. Never wire a submit/primary Button to a read-only tool, and never leave a submit/primary Button with no action: a button that does nothing is a fake affordance. When NO host tool can perform the requested action, do NOT render a dead Submit — render an honest disclaimer (Text/Badge) saying the action isn't available on this host.
- <Island> generated components are a LAST RESORT: one small, self-contained visual piece that no catalog or prewired component can express (a custom chart, a novel visualization). NEVER put the whole app, layout, data, or fetching inside an island. Island content is top-level <Island name="PascalName">raw TSX with an \`export default\`</Island>, referenced as <PascalName/> — plain source, never wrapped in braces, template literals, or fences.
- An island runs in a network-denied sandbox and may import ONLY react/react-dom (${JAIL_ALLOWED_MODULES.join(", ")}); NOTHING else loads. NEVER import a chart or utility library (no recharts, d3, chart.js, victory, nivo, lodash): render a chart as dependency-free INLINE SVG inside the island, or use a prewired/host component instead. Pass the chart's numbers in as props bound to a <Query>; never fabricate them.
- Maximums: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} islands, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per island, ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes of island source total.`,
}, {
  id: "prewired-props",
  content: `PREWIRED COMPONENT PROPS (use these EXACT prop names — any other name is silently dropped and fails validation):\n${prewiredSchemaPrompt()}`,
}, ...hostToolSections(deps),
...generationPromptSections(deps).filter(({ id }) =>
  id === "component-styling" || id === "catalog" || id === "theme" || id === "design-rules")];

/** verify-v2 fixes — the tools a query may name, and (v2 spec §3) the shape
 *  cards the model must bind against. Without the tool list the model invents
 *  tool names; without shapes it binds blind (the broken-chart class). */
const hostToolSections = (deps: GenerationDependencies): GenerationPromptSection[] => [
  ...(deps.tools === undefined || deps.tools.length === 0 ? [] : [{
    id: "catalog" as const,
    content: `HOST TOOLS (the ONLY tools a <Query> or action may name — anything else is a validation error):\n${deps.tools.map(({ name, description, risk }) => `- ${name} [${risk}]: ${description}`).join("\n")}`,
  }]),
  ...(deps.toolShapes === undefined || Object.keys(deps.toolShapes).length === 0 ? [] : [{
    id: "catalog" as const,
    content: `TOOL RESPONSE SHAPES (bind only to fields that exist; a binding outside these shapes fails validation):\n${Object.entries(deps.toolShapes).map(([tool, shape]) => `- ${tool}: ${describeShape(shape)}`).join("\n")}`,
  }, {
    id: "catalog" as const,
    content: `RESHAPE PIPES — project & format bound data to the shape a component needs. A binding may end with a bounded \`| op(...)\` pipe (this is the ONLY computation allowed in a binding). PROJECT fetched object arrays into the component's shape, and never bind a raw object array into a slot that expects labeled items:
- Select options / Tabs tabs need [{value, label}] items. Map a fetched object array with asOptions(valueField, labelField): options={accounts | asOptions(id, name)} — first arg becomes value, second becomes label. Binding a raw object array (e.g. options={accounts}) renders every option BLANK and fails validation.
- Chart/points props need [{label, value}] items: points={revenue.rows | asPoints(month, revenue)}.
FORMAT for DISPLAY — money from host tools is integer CENTS, and dates are raw ISO/epoch; a bare number or ISO string shown to the user is a defect. But format(...) turns a number into a STRING, so it is ONLY for text the user reads, NEVER for data a component computes on:
- format(...) belongs on a text/label slot: a Text/Stat value, a Badge label, or a Table column of a prewired Table. Money (integer cents): value={txn.amount | format(currencyCents)}, or a table column in place: rows={txns | format(amount, currencyCents)}. Dates: value={invoice.dueDate | format(date)}. Percents (0..1): format(percent). Plain numbers: format(number). Use format(currency) only when the field is already in whole dollars.
- This is NOT optional: EVERY date/timestamp field and EVERY cents money field shown in a Table column, Stat, Text, or Badge MUST carry a format step — chain one per column, e.g. rows={deadlines.data | format(dueDate, date) | format(amount, currencyCents)}. A raw ISO string like 2026-07-21T17:00:00-07:00 or raw cents like 285000 on screen is a defect, on EVERY host.
- NEVER format a value bound into a CHART or visualization component — anything that draws from numbers (a *Chart/*Donut/*Graph/*Plot host component, or its slices/series/points/segments/data/values prop), an <Island>, or a reshape aggregate (sum/avg/asPoints). Those need the RAW numeric field; a chart or total fed formatted STRINGS computes NaN and draws nothing. Example: for a spending donut + a table off the same query, bind slices={spending.data} (raw) but rows={spending.data | format(amount, currencyCents)} (formatted) — do NOT reuse the formatted binding for the donut.
NEVER bind a raw object or array into a Text body, a Stat value, a Badge label, or a Table cell — it renders as raw JSON like {"received":3,"total":6} and fails validation. Project object-valued fields to ONE readable string with template:
- Per-row (an object-valued Table column): rows={deadlines.data | template(progress, "{progress.received} of {progress.total}") | template(assignedTo, "{assignedTo.name}")} — template(field, "pattern") rewrites that field per row; {path} placeholders are dot-paths into the row, so nested scalars like {assignedTo.name} work.
- Whole-value (a Text/Stat bound to one object): value={dashboard.data.nearestDeadline | template("{clientName} — {dueDate}")} — template("pattern") turns the object into the interpolated string.
Otherwise bind the specific scalar field ({deadlines.data.0.client}) or exclude the object column via columns=[...scalar keys].`,
  }]),
];

const wireContract = (deps: GenerationDependencies): string =>
  composePromptSections(wireContractSections(deps));

/** v2 spec §4 — the tier-0 lane emits a complete, fully-WIRED generic app
 *  immediately; the full lane then upgrades it in place by stable id. */
const tier0Contract = (deps: GenerationDependencies): string => `${wireContract(deps)}

PAINT PASS (tier-0): emit a complete, minimal, fully-wired GENERIC app for the request RIGHT NOW.
- Catalog components with conservative default props; real <Query> declarations for the most relevant read tools so live data flows immediately.
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
    const compiled = compileWireV2(extractWire(text), { hostComponents, ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }) });
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
    return { compiled: compileWireV2(extractWire(text), { hostComponents, ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }) }), raw: extractWire(text), issues: [] };
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
 *  default-export check still applies. */
const esbuildTransform = (async () => {
  try {
    const esbuild = await import("esbuild");
    return (source: string) => void esbuild.transformSync(source, { loader: "tsx" });
  } catch {
    return undefined;
  }
})();

/** Every module specifier an island source imports — static (`import … from`,
 *  side-effect `import "x"`, `export … from`), dynamic `import("x")`, and
 *  `require("x")`. The jail's sucrase loader rewrites all of these to its
 *  require table, so any specifier here that is not a `JAIL_ALLOWED_MODULES`
 *  entry cannot resolve at runtime. */
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

const JAIL_ALLOWED_MODULE_SET = new Set<string>(JAIL_ALLOWED_MODULES);

/** verify-v2 fixes — a broken island must never persist: it renders as a
 *  contained error instead of an app. Checked at create, routed to repair.
 *  An island reaching for a module the jail cannot load (a chart library, a
 *  util) error-boxes the whole app (verify-v2 #5: `recharts`), so a disallowed
 *  import is rejected before the syntax gate. */
const islandIssues = async (components: Record<string, string>): Promise<string[]> => {
  const issues: string[] = [];
  const transform = await esbuildTransform;
  for (const [name, source] of Object.entries(components)) {
    if (!hasDefaultExport(source)) {
      issues.push(`island "${name}" must be plain TSX with an \`export default\` component — no braces, template literals, or fences around the source`);
      continue;
    }
    const disallowed = [...new Set(islandImportSpecifiers(source))].filter((specifier) => !JAIL_ALLOWED_MODULE_SET.has(specifier));
    if (disallowed.length > 0) {
      issues.push(`island "${name}" imports ${disallowed.map((specifier) => `"${specifier}"`).join(", ")} — the Vendo jail can load ONLY ${JAIL_ALLOWED_MODULES.join(", ")}. Remove the import: render charts as dependency-free inline SVG, or use a prewired/host component; never import an external chart or utility library.`);
      continue;
    }
    if (transform === undefined) continue;
    try {
      transform(source);
    } catch (error) {
      issues.push(`island "${name}" is not valid TSX: ${error instanceof Error ? error.message.split("\n")[0] : "syntax error"}`);
    }
  }
  return issues;
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
  const normalized = Object.fromEntries(
    Object.entries(compiled.components).map(([islandName, source]) => [islandName, normalizeIslandSource(source)]),
  );
  const components = Object.keys(normalized).length === 0 ? undefined : normalized;
  issues.push(...await islandIssues(normalized));
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
  issues.push(...interpolationIssues(compiled));
  issues.push(...await catalogIssues(compiled.tree, components, deps.catalog));
  issues.push(...actionIssues(compiled.tree, deps.tools));
  issues.push(...rootedRenderIssues(compiled.tree));
  if (issues.length > 0) return { issues };
  const document: GeneratedAppDocument = {
    format: VENDO_APP_FORMAT,
    name,
    ui: "tree",
    tree: structuredClone(compiled.tree) as unknown as NonNullable<AppDocument["tree"]>,
    ...(components === undefined ? {} : { components: structuredClone(components) }),
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
      return `node "${fault.nodeId}" is a submit button ("${fault.label}") with no action — a button that does nothing is a fake affordance. Wire its onClick to a host tool that performs the action, binding the form/row context into payload; or if NO host tool can perform it, replace the button with an honest Text/Badge disclaimer that the action isn't available.`;
    }
    if (fault.kind === "missing-payload") {
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes mutating tool "${fault.action}" with no payload — bind the context it acts on (a per-row id, or the form field values) into payload:{...} so the action has something to change.`;
    }
    return `node "${fault.nodeId}" submit button ("${fault.label}") prop "${fault.prop}" is wired to read-only tool "${fault.action}" — a submit that only reads is a fake affordance. Wire it to a mutating host tool with a payload, or render an honest disclaimer if the host has none.`;
  });

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
      ...actionIssues(sourceTreeValidation.tree, deps.tools),
    ])
    : new Set<string>();
  return [
    ...rootedRenderIssues(treeValidation.tree).filter((issue) => !sourceRenderIssues.has(issue)),
    ...(await catalogIssues(treeValidation.tree, app.components, deps.catalog)).filter((issue) => !sourceCatalogIssues.has(issue)),
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
- <Island name="PascalName">raw TSX with a default export</Island> adds or replaces a generated component; <RemoveIsland name="PascalName"/> deletes it.
- <SetName name="..."/> renames the app; <SetDescription text="..."/> sets its description.
- <ForkPin slot="exact remixable slot" into="parent-id" at={index} props={{...}}/> forks a remixable host slot (see REMIXABLE HOST SLOTS).
Emit at least one op. Keep patches minimal and local to the instruction.`,
}, ...generationPromptSections(deps).filter(({ id }) =>
  id === "component-styling" || id === "catalog" || id === "theme" || id === "design-rules" || id === "remixable-slots")]);

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
        if (Object.keys(patched.components).length === 0) {
          delete app.components;
        } else {
          app.components = structuredClone(patched.components);
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
        if (extensionIssues.length === 0) {
          const validationIssues = await validateEditedApp(app, deps, input.app);
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

/** 06-apps §§2,5; v2 spec §§2,4 — wire-backed rung-1 generation and
 *  two-dialect edit planning. */
export const modelEngine: GenerationEngine = {
  async create(input, deps) {
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
      endPass(document, input.prompt, pipelineContext);
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
            wireContract(deps),
            prompt,
            hostComponents,
            { lane: "section", thinking: false, startedAt },
          );
          return output.raw;
        },
        ...(fullLaneDeps.onPartial === undefined ? {} : {
          emitPartial: (assembledWire: string) => {
            const compiled = compileWireV2(assembledWire, { hostComponents, ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }) });
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
        wireContract(deps),
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
    if (resident !== undefined) return resident;
    throw new VendoError("validation", "model could not produce a valid app", issues);
  },
  async edit(input, deps) {
    // execution-v2 Wave 3 — the engine only patches the tree. Server work is
    // the in-box agent's job (graduation, runtime.machine.editApp); the tree
    // gains its fn: bindings through this same tree-edit path afterward.
    return editTree(input, deps);
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
export const instructionRequiresServer = (app: AppDocument, instruction: string): boolean =>
  SERVER_INSTRUCTION.test(instruction)
  || SERVED_APP_INSTRUCTION.test(instruction)
  || app.ui === "http"
  || [...instruction.matchAll(AMBIGUOUS_SERVER_TERM)].some((match) =>
    !VISIBLE_ELEMENT_LABEL.test(instruction.slice(match.index + match[0].length).trimStart()));

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
