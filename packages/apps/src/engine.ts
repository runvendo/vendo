import {
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  VENDO_APP_FORMAT,
  VendoError,
  isPathBinding,
  isStateBinding,
  validateAppDocument,
  validateTree,
  type AppDocument,
  type ComponentCatalog,
  type Json,
  type Tree,
  type TreeNode,
  type TreeQuery,
  type VendoTheme,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import {
  IncrementalTreeParser,
  parseModelJson,
  type IncrementalGeneratedTree,
} from "./incremental-tree.js";
import { pinComponentName, type PinBaseline } from "./pins.js";

export interface GenerationDependencies {
  model: LanguageModel;
  catalog: ComponentCatalog;
  theme?: VendoTheme;
  designRules?: string;
  pinBaselines?: readonly PinBaseline[];
  /** 06-apps §5 — additive, optional partial-tree streaming seam. */
  onPartial?: (partial: IncrementalGeneratedTree) => void | Promise<void>;
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
const SERVER_INSTRUCTION = /\b(server|server-side|backend|api|database|persist|mutation|mutate|external|http|web app|function|secret|egress)\b/i;
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
  content: `TREE CONTRACT:
- At rest the app is {name, description?, tree, components?}; never emit id, server, secrets, egress, storage, or authority.
- tree.formatVersion is "vendo-genui/v1" and tree contains root, nodes, optional data and queries.
- Maximums: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} generated components, ${TREE_MAX_COMPONENT_SOURCE_CHARS} characters per generated component, ${TREE_MAX_TOTAL_COMPONENT_CHARS} total generated-component characters.
- Reserved prewired primitive names: ${RESERVED_COMPONENT_NAMES.join(", ")}.
- Every node is exactly {id, component, source, props?, children?}. "component" is a REQUIRED non-empty string on EVERY node, including layout containers — use a prewired primitive (e.g. Stack, Row, Grid) as the component for containers; children is an array of node ids. Never emit a node without a component.
- "nodes" is a FLAT array of every node; nesting is expressed only through "children" id references, never by inlining child objects. "root" is the id of the top node.
- A node source is "prewired", "host", or "generated". Generated names are PascalCase, non-reserved, and require a top-level components[name] ESM React source.
- Minimal valid shape: {"name":"X","tree":{"formatVersion":"vendo-genui/v1","root":"r","nodes":[{"id":"r","component":"Stack","source":"prewired","children":["t"]},{"id":"t","component":"Text","source":"prewired","props":{"text":"Hi"}}]}}.
- Prefer a host component whenever it covers the need. Matching the host brand is a hard goal.
- Prop bindings are exactly {"$path":"/json/pointer"} and {"$state":"clientStateKey"}.
- Queries are {path, tool, input?}; path is an RFC 6901 JSON Pointer. Actions embedded in props are {action,payload?}.
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
- A remixable slot is captured host source. To start editing it, emit fork-pin with its exact slot, a new nodeId, and an optional parentId/index. The engine copies the trusted captured source into the named generated component, renders that component, and records the baseline pin.
- After a slot is forked, edit its named generated component with add-component while preserving the pin. Never reproduce or alter a baseline hash yourself.`,
}];

const formatContract = (deps: GenerationDependencies): string =>
  composePromptSections(generationPromptSections(deps));

const generateJson = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
): Promise<{ value?: unknown; issues: string[] }> => {
  const parser = deps.onPartial === undefined ? undefined : new IncrementalTreeParser();
  let latest: IncrementalGeneratedTree | undefined;
  let lastFlushAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending: Promise<void>[] = [];
  const flush = (): void => {
    if (latest === undefined || deps.onPartial === undefined) return;
    const partial = latest;
    latest = undefined;
    lastFlushAt = Date.now();
    pending.push(Promise.resolve(deps.onPartial(partial)).catch(() => undefined));
  };
  const schedule = (partial: IncrementalGeneratedTree): void => {
    latest = partial;
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
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    flush();
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
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
      const partial = parser?.push(delta);
      if (partial !== undefined) schedule(partial);
    }
    await finishPartials();
    return parseModelJson(text);
  } catch (error) {
    await finishPartials();
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

interface GeneratedShape {
  name: string;
  description?: string;
  tree: Tree;
  components?: Record<string, string>;
}

const validateGenerated = async (
  value: unknown,
  deps: GenerationDependencies,
): Promise<{ shape?: GeneratedShape; issues: string[] }> => {
  if (!isRecord(value)) return { issues: ["model output must be an object"] };
  const issues: string[] = [];
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    issues.push("name must be a non-empty string");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    issues.push("description must be a string when present");
  }
  if (value.components !== undefined && !isRecord(value.components)) {
    issues.push("components must be an object when present");
  }
  const components = isRecord(value.components)
    ? Object.fromEntries(Object.entries(value.components).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  if (isRecord(value.components) && Object.keys(components ?? {}).length !== Object.keys(value.components).length) {
    issues.push("every generated component source must be a string");
  }
  const validation = validateTree(
    isRecord(value.tree) ? { ...value.tree, components } : value.tree,
  );
  if (!validation.ok) {
    issues.push(validation.error.message);
  } else {
    issues.push(...await catalogIssues(validation.tree, components, deps.catalog));
  }
  if (issues.length > 0 || !validation.ok || typeof value.name !== "string") return { issues };
  const tree = structuredClone(validation.tree);
  delete tree.components;
  const shape: GeneratedShape = {
    name: value.name.trim(),
    tree,
    ...(typeof value.description === "string" && value.description.trim() !== ""
      ? { description: value.description.trim() }
      : {}),
    ...(components === undefined ? {} : { components }),
  };
  const appValidation = validateAppDocument({
    format: VENDO_APP_FORMAT,
    id: "app_generation_validation",
    ui: "tree",
    ...shape,
  });
  if (!appValidation.ok) return { issues: [appValidation.error.message] };
  return { shape, issues: [] };
};

const createDocument = (shape: GeneratedShape): GeneratedAppDocument => ({
  format: VENDO_APP_FORMAT,
  name: shape.name,
  ...(shape.description === undefined ? {} : { description: shape.description }),
  ui: "tree",
  tree: shape.tree as unknown as NonNullable<AppDocument["tree"]>,
  ...(shape.components === undefined ? {} : { components: shape.components }),
});

type TreeOp = Record<string, unknown> & { op: string };

const distinctIssues = (current: string[], next: string[]): string[] => [
  ...new Set([...current, ...next]),
];

const removeChildReference = (tree: Tree, nodeId: string): void => {
  for (const node of tree.nodes) {
    if (node.children !== undefined) node.children = node.children.filter((child) => child !== nodeId);
  }
};

const insertChild = (parent: TreeNode, nodeId: string, index: unknown): void => {
  const children = parent.children ?? [];
  const position = typeof index === "number" && Number.isInteger(index)
    ? Math.max(0, Math.min(index, children.length))
    : children.length;
  children.splice(position, 0, nodeId);
  parent.children = children;
};

const validOptionalIndex = (value: unknown): boolean => value === undefined
  || (typeof value === "number" && Number.isInteger(value) && value >= 0);

const reachesNode = (tree: Tree, startId: string, targetId: string): boolean => {
  const pending = [startId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === targetId) return true;
    visited.add(current);
    const node = tree.nodes.find(({ id }) => id === current);
    if (node !== undefined) pending.push(...(node.children ?? []));
  }
  return false;
};

const applyTreeOps = (
  source: AppDocument,
  ops: TreeOp[],
  deps: GenerationDependencies,
): { app?: AppDocument; issues: string[] } => {
  const app = structuredClone(source);
  if (app.tree?.formatVersion !== "vendo-genui/v1") {
    return { issues: ["tree ops require a vendo-genui/v1 app"] };
  }
  const tree = app.tree as unknown as Tree;
  const issue = (index: number, operation: TreeOp, message: string): { issues: string[] } => ({
    issues: [`tree op[${index}] ${operation.op} failed: ${message}`],
  });
  const unsupportedFields = (
    index: number,
    operation: TreeOp,
    allowed: string[],
  ): { issues: string[] } | undefined => {
    const unexpected = Object.keys(operation).filter((key) => !allowed.includes(key));
    if (unexpected.length === 0) return undefined;
    return issue(
      index,
      operation,
      `unsupported ${unexpected.length === 1 ? "field" : "fields"} ${unexpected.map((key) => `"${key}"`).join(", ")}; allowed fields are ${allowed.map((key) => `"${key}"`).join(", ")}`,
    );
  };
  for (const [index, operation] of ops.entries()) {
    switch (operation.op) {
      case "set-prop": {
        if (typeof operation.nodeId !== "string" || typeof operation.prop !== "string") {
          return issue(index, operation, `requires nodeId and prop strings; received fields: ${Object.keys(operation).join(", ")}`);
        }
        const unsupported = unsupportedFields(index, operation, ["op", "nodeId", "prop", "value"]);
        if (unsupported !== undefined) return unsupported;
        const node = tree.nodes.find(({ id }) => id === operation.nodeId);
        if (node === undefined) return issue(index, operation, `node "${operation.nodeId}" does not exist`);
        node.props = { ...(node.props ?? {}), [operation.prop]: asJson(operation.value) };
        break;
      }
      case "add-node": {
        if (!isRecord(operation.node)) return issue(index, operation, "requires a node object");
        const unsupported = unsupportedFields(index, operation, ["op", "node", "parentId", "index"]);
        if (unsupported !== undefined) return unsupported;
        const nodeFields = ["id", "component", "source", "props", "children"];
        const unexpectedNodeFields = Object.keys(operation.node).filter((key) => !nodeFields.includes(key));
        if (unexpectedNodeFields.length > 0) {
          return issue(
            index,
            operation,
            `node has unsupported ${unexpectedNodeFields.length === 1 ? "field" : "fields"} ${unexpectedNodeFields.map((key) => `"${key}"`).join(", ")}; allowed node fields are ${nodeFields.map((key) => `"${key}"`).join(", ")}; place parentId and index on the add-node operation`,
          );
        }
        const node = structuredClone(operation.node) as unknown as TreeNode;
        if (typeof node.id !== "string" || node.id.trim() === "") {
          return issue(index, operation, "node requires a non-empty string id");
        }
        if (typeof node.component !== "string" || node.component.trim() === "") {
          return issue(index, operation, "node requires a non-empty string component");
        }
        if (node.source !== undefined && !["prewired", "host", "generated"].includes(node.source)) {
          return issue(index, operation, 'node source must be "prewired", "host", or "generated" when present');
        }
        if (node.props !== undefined && !isRecord(node.props)) {
          return issue(index, operation, "node props must be an object when present");
        }
        if (node.children !== undefined
          && (!Array.isArray(node.children) || !node.children.every((child) => typeof child === "string"))) {
          return issue(index, operation, "node children must be an array of node-id strings when present");
        }
        if (!validOptionalIndex(operation.index)) return issue(index, operation, "index must be a non-negative integer when present");
        if (tree.nodes.some(({ id }) => id === node.id)) return issue(index, operation, `node "${node.id}" already exists`);
        if (typeof operation.parentId !== "string" || operation.parentId.trim() === "") {
          return issue(index, operation, "requires a non-empty parentId string so the added node is attached to the rooted view");
        }
        const parent = tree.nodes.find(({ id }) => id === operation.parentId);
        if (parent === undefined) return issue(index, operation, `parent "${operation.parentId}" does not exist`);
        const childCount = parent.children?.length ?? 0;
        if (typeof operation.index === "number" && operation.index > childCount) {
          return issue(index, operation, `index ${operation.index} leaves a gap in parent "${operation.parentId}" children (length ${childCount})`);
        }
        tree.nodes.push(node);
        insertChild(parent, node.id, operation.index);
        break;
      }
      case "remove-node": {
        if (typeof operation.nodeId !== "string") return issue(index, operation, "requires nodeId");
        const unsupported = unsupportedFields(index, operation, ["op", "nodeId"]);
        if (unsupported !== undefined) return unsupported;
        if (operation.nodeId === tree.root) return issue(index, operation, "cannot remove the tree root");
        const nodeIndex = tree.nodes.findIndex(({ id }) => id === operation.nodeId);
        if (nodeIndex === -1) return issue(index, operation, `node "${operation.nodeId}" does not exist`);
        tree.nodes.splice(nodeIndex, 1);
        removeChildReference(tree, operation.nodeId);
        break;
      }
      case "move-node": {
        if (typeof operation.nodeId !== "string" || typeof operation.parentId !== "string") {
          return issue(index, operation, `requires nodeId and parentId strings; use "nodeId" (not "id") and optional integer "index" (not "position" or "beforeId")`);
        }
        const unsupported = unsupportedFields(index, operation, ["op", "nodeId", "parentId", "index"]);
        if (unsupported !== undefined) return unsupported;
        if (!validOptionalIndex(operation.index)) return issue(index, operation, "index must be a non-negative integer when present");
        if (!tree.nodes.some(({ id }) => id === operation.nodeId)) {
          return issue(index, operation, `node "${operation.nodeId}" does not exist`);
        }
        const parent = tree.nodes.find(({ id }) => id === operation.parentId);
        if (parent === undefined) return issue(index, operation, `parent "${operation.parentId}" does not exist`);
        if (operation.parentId === operation.nodeId
          || reachesNode(tree, operation.nodeId, operation.parentId)) {
          return issue(index, operation, `cannot move "${operation.nodeId}" under itself or its descendant`);
        }
        const targetChildren = (parent.children ?? []).filter((child) => child !== operation.nodeId);
        if (typeof operation.index === "number" && operation.index > targetChildren.length) {
          return issue(index, operation, `index ${operation.index} leaves a gap in parent "${operation.parentId}" children (length ${targetChildren.length})`);
        }
        removeChildReference(tree, operation.nodeId);
        insertChild(parent, operation.nodeId, operation.index);
        break;
      }
      case "set-query": {
        if (typeof operation.index !== "number" || !Number.isInteger(operation.index) || operation.index < 0) {
          return issue(index, operation, "requires a non-negative integer index");
        }
        const unsupported = unsupportedFields(index, operation, ["op", "index", "query"]);
        if (unsupported !== undefined) return unsupported;
        const queries = tree.queries ?? [];
        if (operation.query === null) {
          if (operation.index >= queries.length) return issue(index, operation, `query index ${operation.index} does not exist`);
          queries.splice(operation.index, 1);
        } else if (isRecord(operation.query)) {
          if (operation.index > queries.length) return issue(index, operation, `query index ${operation.index} leaves a gap`);
          queries[operation.index] = structuredClone(operation.query) as unknown as TreeQuery;
        } else {
          return issue(index, operation, "requires a query object or null");
        }
        tree.queries = queries;
        break;
      }
      case "add-component": {
        if (typeof operation.name !== "string" || typeof operation.source !== "string") {
          return issue(index, operation, `requires name and source strings; received fields: ${Object.keys(operation).join(", ")}`);
        }
        const unsupported = unsupportedFields(index, operation, ["op", "name", "source"]);
        if (unsupported !== undefined) return unsupported;
        app.components = { ...(app.components ?? {}), [operation.name]: operation.source };
        break;
      }
      case "fork-pin": {
        if (typeof operation.slot !== "string" || operation.slot.length === 0
          || typeof operation.nodeId !== "string" || operation.nodeId.length === 0) {
          return issue(index, operation, "requires non-empty slot and nodeId strings");
        }
        const unsupported = unsupportedFields(index, operation, ["op", "slot", "nodeId", "parentId", "index", "props"]);
        if (unsupported !== undefined) return unsupported;
        if (!validOptionalIndex(operation.index)) return issue(index, operation, "index must be a non-negative integer when present");
        const baseline = deps.pinBaselines?.find(({ slot }) => slot === operation.slot);
        if (baseline === undefined) return issue(index, operation, `pin baseline "${operation.slot}" is unavailable`);
        if (app.pins?.some(({ slot }) => slot === baseline.slot)) {
          return issue(index, operation, `pin slot "${baseline.slot}" is already forked`);
        }
        const componentName = pinComponentName(baseline.slot);
        if (app.components?.[componentName] !== undefined) {
          return issue(index, operation, `generated component "${componentName}" already exists`);
        }
        if (tree.nodes.some(({ id }) => id === operation.nodeId)) {
          return issue(index, operation, `node "${operation.nodeId}" already exists`);
        }
        const parentId = operation.parentId === undefined ? tree.root : operation.parentId;
        if (typeof parentId !== "string") return issue(index, operation, "parentId must be a string when present");
        const parent = tree.nodes.find(({ id }) => id === parentId);
        if (parent === undefined) return issue(index, operation, `parent "${parentId}" does not exist`);
        const node: TreeNode = {
          id: operation.nodeId,
          component: componentName,
          source: "generated",
          ...(isRecord(operation.props)
            ? { props: structuredClone(operation.props) as TreeNode["props"] }
            : {}),
        };
        tree.nodes.push(node);
        insertChild(parent, node.id, operation.index);
        app.components = { ...(app.components ?? {}), [componentName]: baseline.source };
        app.pins = [...(app.pins ?? []), { slot: baseline.slot, base: baseline.hash }];
        break;
      }
      case "set-name": {
        if (typeof operation.name !== "string" || operation.name.trim() === "") {
          return issue(index, operation, "requires a non-empty name");
        }
        const unsupported = unsupportedFields(index, operation, ["op", "name"]);
        if (unsupported !== undefined) return unsupported;
        app.name = operation.name.trim();
        break;
      }
      case "set-description": {
        if (typeof operation.description !== "string") return issue(index, operation, "requires a string");
        const unsupported = unsupportedFields(index, operation, ["op", "description"]);
        if (unsupported !== undefined) return unsupported;
        app.description = operation.description;
        break;
      }
      default:
        return issue(index, operation, "unsupported tree operation");
    }
  }
  return { app, issues: [] };
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
  if (app.tree?.formatVersion !== "vendo-genui/v1") return ["tree edit produced an unsupported format"];
  const treeValidation = validateTree({ ...app.tree, components: app.components });
  if (!treeValidation.ok) return [treeValidation.error.message];
  const sourceTreeValidation = validateTree({ ...source.tree, components: source.components });
  const sourceRenderIssues = sourceTreeValidation.ok
    ? new Set(rootedRenderIssues(sourceTreeValidation.tree))
    : new Set<string>();
  return [
    ...rootedRenderIssues(treeValidation.tree).filter((issue) => !sourceRenderIssues.has(issue)),
    ...await catalogIssues(treeValidation.tree, app.components, deps.catalog),
  ];
};

const treeOpsFrom = (value: unknown): { ops?: TreeOp[]; issues: string[] } => {
  if (!isRecord(value) || !Array.isArray(value.ops)) return { issues: ["tree edit output must be {ops:[...]}" ] };
  if (value.ops.length === 0) return { issues: ["tree edit must include at least one op"] };
  if (!value.ops.every((op): op is TreeOp => isRecord(op) && typeof op.op === "string")) {
    return { issues: ["every tree edit op must be an object with an op string"] };
  }
  return { ops: value.ops, issues: [] };
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
    if (file.content.length > TREE_MAX_TOTAL_COMPONENT_CHARS) issues.push(`file "${file.path}" is too large`);
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

const editTree = async (
  input: GenerationEditInput,
  deps: GenerationDependencies,
): Promise<GenerationEditResult> => {
  let issues = [...(input.repairIssues ?? [])];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await generateJson(
      deps,
      `${formatContract(deps)}\n\nTREE EDIT DIALECT: emit {"ops":[...]}. Patch the supplied app; do not regenerate it.\nExact op shapes:\n- {"op":"set-prop","nodeId":"...","prop":"...","value":...}\n- {"op":"add-node","node":{"id":"...","component":"...","source":"prewired|host|generated","props":{},"children":[]},"parentId":"...","index":0}\n- {"op":"remove-node","nodeId":"..."}\n- {"op":"move-node","nodeId":"...","parentId":"...","index":0}\n- {"op":"set-query","index":0,"query":{...}|null}\n- {"op":"add-component","name":"PascalCaseName","source":"complete ESM React source"}\n- {"op":"fork-pin","slot":"exact remixable slot","nodeId":"newNodeId","parentId":"...","index":0,"props":{}}\n- {"op":"set-name","name":"..."}\n- {"op":"set-description","description":"..."}\nUse nodeId, never id, for existing nodes. Use index, never position or beforeId. Attach every added visible node with parentId, never add the existing root again, preserve all component sources not intentionally replaced, and never leave the rooted view empty.`,
      `TASK: EDIT_TREE\nINSTRUCTION: ${input.instruction}\nCURRENT_APP: ${JSON.stringify(input.app)}${repairPrompt(issues)}`,
    );
    issues = distinctIssues(issues, output.issues);
    if (output.value !== undefined) {
      const parsed = treeOpsFrom(output.value);
      issues = distinctIssues(issues, parsed.issues);
      if (parsed.ops !== undefined) {
        const applied = applyTreeOps(input.app, parsed.ops, deps);
        issues = distinctIssues(issues, applied.issues);
        if (applied.app !== undefined) {
          const validationIssues = await validateEditedApp(applied.app, deps, input.app);
          if (validationIssues.length === 0) {
            return { kind: "document", document: withoutId(applied.app), rung: 1 };
          }
          issues = distinctIssues(issues, validationIssues);
        }
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
      `${formatContract(deps)}\n\nCODE EDIT DIALECT: emit full small files as {"rung":2|3|4,"files":[{"path":"/app/...","content":"..."}]}. Keep every path under /app. Rung 2 is tree plus server, rung 3 is a server-computed tree, and rung 4 is a served web app. A tree app may graduate to rung 4 when the requested interface outgrows the tree format; the runtime supplies the invisible-graduation scaffold. On that first tree-to-http edit, do not emit /app/tree.json, /app/components.json, /app/tree-renderer.js, /app/index.html, /app/.vendo/scaffold-server.cjs, or /app/start.sh; a later edit to the graduated http app may replace those defaults.`,
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

/** 06-apps §§2,5 — model-backed rung-1 generation and two-dialect edit planning. */
export const modelEngine: GenerationEngine = {
  async create(input, deps) {
    let issues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = await generateJson(
        deps,
        `${formatContract(deps)}\n\nCREATE DIALECT: emit exactly {"name":"...","description":"...","tree":{...},"components":{...}?}. Start and finish at rung 1.`,
        `TASK: CREATE_APP\nUSER_REQUEST: ${input.prompt}${repairPrompt(issues)}`,
      );
      issues = output.issues;
      if (output.value !== undefined) {
        const validated = await validateGenerated(output.value, deps);
        issues = validated.issues;
        if (validated.shape !== undefined) return createDocument(validated.shape);
      }
    }
    throw new VendoError("validation", "model could not produce a valid app", issues);
  },
  async edit(input, deps) {
    return SERVER_INSTRUCTION.test(input.instruction) || input.app.ui === "http"
      ? editCode(input, deps)
      : editTree(input, deps);
  },
};

/** 06-apps §2 — whether an instruction needs the machine/code edit dialect. */
export const instructionRequiresServer = (app: AppDocument, instruction: string): boolean =>
  SERVER_INSTRUCTION.test(instruction) || app.ui === "http";

/** 01-core §8 — generated component naming check exported for focused engine tests. */
export const isGeneratedComponentName = (name: string): boolean =>
  PASCAL_CASE.test(name) && !reserved.has(name);
