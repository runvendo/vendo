import {
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
  printWireV2,
  isPathBinding,
  isStateBinding,
  validateAppDocument,
  validateTreeV2,
  type AppDocument,
  type ComponentCatalog,
  type Json,
  type ShapeType,
  type Tree,
  type TreeNode,
  type TreeQueryV2,
  type TreeV2,
  type VendoTheme,
  type WireCompileResult,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { parseModelJson } from "./incremental-tree.js";
import { hasDefaultExport, pinComponentName, pinForkSource, type PinBaseline } from "./pins.js";

/** v2 spec §§1,4 — a compiled prefix of the streaming wire: always a
 *  validateTreeV2-passing tree (valid-while-partial) plus the islands
 *  admitted so far. */
export interface GeneratedPartial {
  name?: string;
  tree: TreeV2;
  components?: Record<string, string>;
}

export interface GenerationDependencies {
  model: LanguageModel;
  catalog: ComponentCatalog;
  theme?: VendoTheme;
  designRules?: string;
  pinBaselines?: readonly PinBaseline[];
  /** v2 spec §3 — shape-card outputs keyed by tool; when present, create and
   *  edit compiles type-check bindings and surface shape-mismatch repair. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
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

export interface CodeFileEdit {
  path: string;
  content: string;
}

export type GenerationEditResult =
  | { kind: "document"; document: GeneratedAppDocument; rung: 1 }
  | { kind: "code"; files: CodeFileEdit[]; rung: 2 | 3 | 4 }
  | { kind: "failure"; issues: string[] };

/** 06-apps §5 — replaceable generation seam used by createApps(). */
export interface GenerationEngine {
  create(input: GenerationCreateInput, deps: GenerationDependencies): Promise<GeneratedAppDocument>;
  edit(input: GenerationEditInput, deps: GenerationDependencies): Promise<GenerationEditResult>;
}

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const SAFE_MACHINE_PATH = /^\/app\/[A-Za-z0-9._/-]+$/;
const SERVER_INSTRUCTION = /\b(server|server-side|backend|database|persist|mutation|mutate|egress)\b/i;
// Words that signal server work only outside a visible-element label: "call the
// api" needs code, "the API status card" is a tree edit (ENG-349).
const AMBIGUOUS_SERVER_TERM = /\b(api|http|web app|function|external|secret)\b/gi;
const VISIBLE_ELEMENT_LABEL = /^(?:\w+\s+)?(card|button|badge|chip|header|heading|title|label|caption|text|list|table|column|row|cell|section|panel|chart|graph|icon|field|tab|menu|toolbar|sidebar|footer|banner|tile|widget)s?\b/i;
const SERVER_COMPUTED_INSTRUCTION = /\b(server-computed|computed (?:view|tree)|render(?:ed)? on the server)\b/i;
const FULL_WEB_APP_INSTRUCTION = /\b(full web app|served web app|custom client|ui:? ?http)\b/i;
const reserved = new Set<string>(RESERVED_COMPONENT_NAMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asJson = (value: unknown): Json => value as Json;

const catalogPrompt = (catalog: ComponentCatalog): string => JSON.stringify(
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
  id: "role" | "tree-contract" | "component-styling" | "catalog" | "theme" | "design-rules" | "remixable-slots";
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

const formatContract = (deps: GenerationDependencies): string =>
  composePromptSections(generationPromptSections(deps));

/** v2 spec §2 — the JSX-wire create contract. The model emits markup, never
 *  JSON; the deterministic compiler owns ids, bindings, and validation. */
const wireContractSections = (deps: GenerationDependencies): GenerationPromptSection[] => [{
  id: "role",
  content: "You are the Vendo app generation engine. Return ONLY vendo-genui/v2 wire markup: a single <App> element. No prose, no markdown fences, no JSON.",
}, {
  id: "tree-contract",
  content: `WIRE DIALECT (vendo-genui/v2):
- Emit exactly one <App name="..."> element containing the whole app. Positional nesting expresses the tree; NEVER emit id attributes — the compiler mints stable ids.
- <Query id="queryName" tool="tool_name" input={{...}}/> declarations come FIRST inside <App>, before layout, so data fetching starts while the rest streams. A query result lives at the query's name; bind it into props with expressions like value={queryName} or value={queryName.field.path}.
- Attribute values: "string", {42}, {true}, bare attribute for true, {{...}} objects, {[...]} arrays, and query bindings {queryName.path.segments}.
- Components resolve host catalog -> prewired primitives -> your <Island> components; the host brand wins a name collision. Prewired primitives: ${RESERVED_COMPONENT_NAMES.join(", ")}, Card, Button, Input, Select, Table, Badge, Stat, Tabs.
- Prefer a host catalog component whenever it covers the need, with its exact name and props schema. Matching the host brand is a hard goal.
- Actions are on* attributes naming a host tool or fn:<name> (name matches [A-Za-z_][A-Za-z0-9_-]*), e.g. onClick="host_tool" or onRun="fn:submit". A rung-1 app has no server, so never use fn: on create.
- Generated components are top-level <Island name="PascalName">raw TSX with a default export</Island>, referenced as <PascalName/>. No JSON escaping — write plain TSX.
- Maximums: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} islands, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per island, ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes of island source total.`,
}, ...generationPromptSections(deps).filter(({ id }) =>
  id === "component-styling" || id === "catalog" || id === "theme" || id === "design-rules")];

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
 *  (the v1 JSON path had the same tolerance in parseModelJson). The wire is
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
): Promise<{ compiled?: WireCompileResult; issues: string[] }> => {
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAt = 0;
  const pending: Promise<void>[] = [];
  const flush = (): void => {
    if (deps.onPartial === undefined) return;
    lastFlushAt = Date.now();
    const compiled = compileWireV2(extractWire(text), { hostComponents });
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
    return { compiled: compileWireV2(extractWire(text), { hostComponents }), issues: [] };
  } catch (error) {
    await finishPartials();
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

/** v2 create validation: the compile must be complete and clean, the tree
 *  catalog-consistent and renderable, and the assembled document valid. */
const validateCompiledCreate = async (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
): Promise<{ document?: GeneratedAppDocument; issues: string[] }> => {
  const issues: string[] = [];
  if (!compiled.complete) issues.push("wire did not parse to a complete <App> document");
  issues.push(...compiled.issues.map(({ code, message }) => `wire ${code}: ${message}`));
  const name = compiled.name?.trim() ?? "";
  if (name === "") issues.push('App must carry a non-empty name="..." attribute');
  const components = Object.keys(compiled.components).length === 0 ? undefined : compiled.components;
  issues.push(...await catalogIssues(compiled.tree as unknown as Tree, components, deps.catalog));
  issues.push(...rootedRenderIssues(compiled.tree as unknown as Tree));
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

/** Edit-dialect model call: accumulate the stream and parse it as JSON.
 *  (The v1 create-streaming parser is gone — v2 creates stream through the
 *  wire compiler in {@link streamWire}.) */
const generateJson = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
): Promise<{ value?: unknown; issues: string[] }> => {
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
    return parseModelJson(text);
  } catch (error) {
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
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
  component: ComponentCatalog[number],
): Promise<string[]> => {
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

const catalogIssues = async (
  tree: Tree,
  components: Record<string, string> | undefined,
  catalog: ComponentCatalog,
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
    } else if (node.source === "prewired" && !reserved.has(node.component)) {
      issues.push(`node "${node.id}" references unknown prewired component "${node.component}"`);
    } else if (node.source === "generated" && !generatedNames.has(node.component)) {
      issues.push(`node "${node.id}" references generated component "${node.component}" without source`);
    } else if (node.source === undefined
      && !hostNames.has(node.component)
      && !reserved.has(node.component)
      && !generatedNames.has(node.component)) {
      issues.push(`node "${node.id}" references unknown component "${node.component}"`);
    }
  }
  return issues;
};

const distinctIssues = (current: string[], next: string[]): string[] => [
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

const rootedRenderIssues = (tree: Tree): string[] => {
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
  const sourceRenderIssues = sourceTreeValidation.ok
    ? new Set(rootedRenderIssues(sourceTreeValidation.tree as unknown as Tree))
    : new Set<string>();
  return [
    ...rootedRenderIssues(treeValidation.tree as unknown as Tree).filter((issue) => !sourceRenderIssues.has(issue)),
    ...await catalogIssues(treeValidation.tree as unknown as Tree, app.components, deps.catalog),
  ];
};

const safeFilePath = (path: string): boolean =>
  SAFE_MACHINE_PATH.test(path) && !path.split("/").includes("..");

const codePlanFrom = (
  value: unknown,
  app: AppDocument,
  instruction: string,
): { files?: CodeFileEdit[]; rung?: 2 | 3 | 4; issues: string[] } => {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return { issues: ["code edit output must be {rung,files:[{path,content}]}"] };
  }
  const issues: string[] = [];
  const files: CodeFileEdit[] = [];
  if (value.files.length === 0 || value.files.length > 32) issues.push("code edit must contain 1 to 32 files");
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
      issues.push("every code file edit requires path and content strings");
      continue;
    }
    if (!safeFilePath(file.path)) issues.push(`unsafe machine path "${file.path}"; paths must stay under /app`);
    if (new TextEncoder().encode(file.content).length > TREE_MAX_TOTAL_COMPONENT_BYTES) issues.push(`file "${file.path}" is too large`);
    files.push({ path: file.path, content: file.content });
  }
  // Rung is the capability level actually reached, so either signal that indicates a
  // higher rung wins: the model's own declaration of what it built (previously validated
  // then discarded — Devin) OR the instruction heuristic.
  const policyRung = app.ui === "http" || FULL_WEB_APP_INSTRUCTION.test(instruction)
    ? 4
    : SERVER_COMPUTED_INSTRUCTION.test(instruction) ? 3 : 2;
  const declaredRaw = value.rung;
  const declared = declaredRaw === 2 || declaredRaw === 3 || declaredRaw === 4 ? declaredRaw : undefined;
  if (declaredRaw !== undefined && declared === undefined) {
    issues.push("code edit rung must be 2, 3, or 4");
  }
  const rung = (declared !== undefined && declared > policyRung ? declared : policyRung) as 2 | 3 | 4;
  return issues.length > 0
    ? { issues }
    : { files, rung, issues: [] };
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

/** Same fence tolerance as {@link extractWire}, for <Edit> documents. */
const extractEdit = (text: string): string => {
  const start = text.indexOf("<Edit");
  if (start === -1) return text;
  const closeTag = "</Edit>";
  const close = text.lastIndexOf(closeTag);
  return close === -1 ? text.slice(start) : text.slice(start, close + closeTag.length);
};

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
            return { kind: "document", document: withoutId(app), rung: 1 };
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

const editCode = async (
  input: GenerationEditInput,
  deps: GenerationDependencies,
): Promise<GenerationEditResult> => {
  let issues = [...(input.repairIssues ?? [])];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await generateJson(
      deps,
      `${formatContract(deps)}\n\nCODE EDIT DIALECT: emit full small files as {"rung":2|3|4,"files":[{"path":"/app/...","content":"..."}]}. Keep every path under /app. Rung 2 is tree plus server, rung 3 is a server-computed tree, and rung 4 is a served web app. A rung 2 or 3 server must be a plain Node HTTP server listening on process.env.PORT that answers POST /fn/<name> with {"result":...} (or {"ui":<tree>} for rung 3); its entry point must be /app/start.sh or /app/server.js — the runtime starts that entry and rejects the edit when nothing serves $PORT. A tree app may graduate to rung 4 when the requested interface outgrows the tree format; the runtime supplies the invisible-graduation scaffold. On that first tree-to-http edit, do not emit /app/tree.json, /app/components.json, /app/tree-renderer.js, /app/index.html, /app/.vendo/scaffold-server.cjs, /app/.vendo/fetch-shim.cjs, or /app/start.sh; a later edit to the graduated http app may replace those defaults. Never emit /app/.vendo/fetch-shim.cjs at any rung — the runtime owns it. Server code may call fetch() to external hosts normally, sending declared secret env vars (opaque handles) in headers or body; the runtime routes outbound fetch through the Vendo egress proxy, which substitutes real secret values for allowlisted hosts only.`,
      `TASK: EDIT_CODE\nINSTRUCTION: ${input.instruction}\nCURRENT_APP: ${JSON.stringify(input.app)}${repairPrompt(issues)}`,
    );
    issues = distinctIssues(issues, output.issues);
    if (output.value !== undefined) {
      const plan = codePlanFrom(output.value, input.app, input.instruction);
      issues = distinctIssues(issues, plan.issues);
      if (plan.files !== undefined && plan.rung !== undefined) {
        return { kind: "code", files: plan.files, rung: plan.rung };
      }
    }
  }
  return { kind: "failure", issues: issues.length === 0 ? ["code edit failed validation"] : issues };
};

/** 06-apps §§2,5; v2 spec §§2,4 — wire-backed rung-1 generation and
 *  two-dialect edit planning. */
export const modelEngine: GenerationEngine = {
  async create(input, deps) {
    const hostComponents = deps.catalog.map(({ name }) => name);
    const basePrompt = `TASK: CREATE_APP\nUSER_REQUEST: ${input.prompt}`;
    // Tier-0 paint lane (v2 spec §4): only with a streaming consumer — the
    // instant paint exists to reach a screen. One attempt, no repair loop:
    // an invalid paint is simply not resident (the full lane still runs).
    let resident: GeneratedAppDocument | undefined;
    let residentLayout: string | undefined;
    if (deps.onPartial !== undefined && deps.paint?.disabled !== true) {
      const paintDeps = deps.paint?.model === undefined ? deps : { ...deps, model: deps.paint.model };
      const paint = await streamWire(paintDeps, tier0Contract(deps), basePrompt, hostComponents);
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
    let issues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = await streamWire(
        fullLaneDeps,
        wireContract(deps),
        `${basePrompt}${residentLayout === undefined
          ? ""
          : `\nTIER0_LAYOUT: ${residentLayout}\nAn instant paint pass already rendered that layout. Emit the full-quality app; keep the top-level component ordering compatible where reasonable so minted node ids stay stable and the upgrade swaps in place.`}${repairPrompt(issues)}`,
        hostComponents,
      );
      issues = distinctIssues(issues, output.issues);
      if (output.compiled !== undefined) {
        const validated = await validateCompiledCreate(output.compiled, deps);
        issues = distinctIssues(issues, validated.issues);
        if (validated.document !== undefined) return validated.document;
      }
    }
    // Never a white box: a failed full lane falls back to the resident
    // tier-0 app (v2 spec §4).
    if (resident !== undefined) return resident;
    throw new VendoError("validation", "model could not produce a valid app", issues);
  },
  async edit(input, deps) {
    return instructionRequiresServer(input.app, input.instruction)
      ? editCode(input, deps)
      : editTree(input, deps);
  },
};

/**
 * 06-apps §2 — whether an instruction needs the machine/code edit dialect.
 * Every rung-4 phrase `codePlanFrom` recognizes must route here too, or a
 * graduation request (e.g. "custom client") would take the tree dialect and
 * never reach the scaffold (Greptile, PR #243).
 * Ambiguous words like "api" or "function" count only when they are not
 * labeling a visible element — "make the API status card blue" must stay on
 * the cheap tree dialect instead of failing slowly through code (ENG-349).
 */
export const instructionRequiresServer = (app: AppDocument, instruction: string): boolean =>
  SERVER_INSTRUCTION.test(instruction)
  || FULL_WEB_APP_INSTRUCTION.test(instruction)
  || app.ui === "http"
  || [...instruction.matchAll(AMBIGUOUS_SERVER_TERM)].some((match) =>
    !VISIBLE_ELEMENT_LABEL.test(instruction.slice(match.index + match[0].length).trimStart()));

/** 01-core §8 — generated component naming check exported for focused engine tests. */
export const isGeneratedComponentName = (name: string): boolean =>
  PASCAL_CASE.test(name) && !reserved.has(name);
