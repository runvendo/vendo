/**
 * Create/edit validation — everything ENFORCED on a compiled document: the
 * compile must be complete and clean, the tree catalog-consistent and
 * renderable, islands syntactically sound, queries aimed at real host tools,
 * bindings shape-checked, and the assembled document valid.
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  WIRE_COMPONENT_NAMES,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT_V2,
  kitSpec,
  shapeAtPointer,
  isPathBinding,
  isStateBinding,
  validateAppDocument,
  validateTreeV2,
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
  type TreeNode,
  type TreeV2,
  type WireCompileResult,
} from "@vendoai/core";
import { prewiredPropNames } from "../../prewired-schema.js";
import { APP_NAME_MAX_CHARS } from "../contracts/sections.js";
import type {
  GeneratedAppDocument,
  GenerationDependencies,
} from "../engine.js";
import { actionIssues } from "./actions.js";
import { literalDataIssues } from "./literals.js";
import { prepareIslands } from "./islands.js";
import { smokeRenderIslands } from "./smoke-render.js";

const reserved = new Set<string>(WIRE_COMPONENT_NAMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Conservative kind check between a bound field's shape and the host prop's
 *  declared JSON-schema type: only CLEAR mismatches flag (an array of objects
 *  where number[] is expected renders an empty chart — the silent-breakage
 *  class); unknown shapes/schemas stay silent. */
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

/** With tool shapes AND the catalog's prop schemas both in hand, a top-level
 *  `$path` prop on a host node can be kind-checked end to end. Existence is
 *  shape-check.ts's job; this catches the type mismatches that render
 *  silently broken (empty chart, blank stat). */
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

/** asPoints/asOptions produce generic {label,value}/{value,label} items; a
 *  HOST prop whose schema declares its OWN item field names cannot read them
 *  (live finding: the Maple donut drew $NaN). The raw rows are the legal
 *  binding — reject the reshape at compile. */
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

/** Law 2 — a query input executes as LITERAL JSON: the runtime never
 *  resolves bindings inside it, so a dependent call
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

/** Law 1 raw typing — probe values per shape kind, parsed against the Kit
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

/** Models write "Total: {metric.total}" inside STRING attributes; the wire
 *  has no string interpolation, so the braces render literally. Any string
 *  prop embedding a declared query reference is a repair-routed error. */
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

const standardIssuePath = (issue: unknown): Array<string | number> => {
  if (!isRecord(issue) || !Array.isArray(issue.path)) return [];
  return issue.path.flatMap((segment) => {
    const key = isRecord(segment) && "key" in segment ? segment.key : segment;
    return typeof key === "string" || typeof key === "number" ? [key] : [];
  });
};

const isActionBinding = (value: unknown): boolean =>
  isRecord(value) && typeof value.action === "string";

const isRuntimeBound = (value: unknown): boolean =>
  isPathBinding(value) || isStateBinding(value) || isActionBinding(value);

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

/** Create validation: the compile must be complete and clean, the tree
 *  catalog-consistent and renderable, islands syntactically sound, queries
 *  aimed at real host tools, bindings shape-checked, and the assembled
 *  document valid. */
export const validateCompiledCreate = async (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
): Promise<{ document?: GeneratedAppDocument; issues: string[] }> => {
  const issues: string[] = [];
  if (!compiled.complete) issues.push("wire did not parse to a complete <App> document");
  issues.push(...compiled.issues.map(({ code, message }) => `wire ${code}: ${message}`));
  const name = compiled.name?.trim() ?? "";
  if (name === "") {
    issues.push('App must carry a non-empty name="..." attribute');
  } else if (name.length > APP_NAME_MAX_CHARS) {
    issues.push(`App name="${name}" is ${name.length} characters — name is the app's display title (at most ${APP_NAME_MAX_CHARS} characters); write a short human title, never the request echoed back`);
  }
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
  // The smoke-render gate (crash classes the 2026-07-21 gate shipped: React
  // #310 hooks-in-map, undefined names, unguarded-data throws). Runs LAST,
  // only on otherwise-clean documents, so cheap failures never pay for a
  // render; source-keyed caching makes repair/end-pass revalidation of
  // unchanged islands free.
  if (components !== undefined && deps.pipeline?.smokeRender !== false) {
    issues.push(...await smokeRenderIslands({
      components,
      componentTools: prepared.componentTools,
      tools: deps.tools,
      toolShapes: deps.toolShapes,
    }));
    if (issues.length > 0) return { issues };
  }
  const document: GeneratedAppDocument = {
    format: VENDO_APP_FORMAT,
    name,
    ui: "tree",
    tree: structuredClone(compiled.tree) as unknown as NonNullable<AppDocument["tree"]>,
    ...(components === undefined ? {} : {
      components: structuredClone(components),
      // The compiler-stamped per-island tool manifest (least privilege: an
      // island with no tools carries an explicit empty list).
      componentTools: structuredClone(prepared.componentTools),
    }),
  };
  const appValidation = validateAppDocument({ ...document, id: "app_generation_validation" });
  if (!appValidation.ok) return { issues: [appValidation.error.message] };
  return { document, issues: [] };
};

/** Edit validation. Every per-node check is filtered against the pre-existing
 *  app the same way, so an edit that doesn't touch a stale node (a legacy
 *  Table.data prop, an already-dead button) is never blocked by that node's
 *  issue — only issues the edit newly introduces surface. Ids are stable
 *  across an edit, so a carried-over issue is a byte-identical string. */
export const validateEditedApp = async (
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
