/**
 * The built-in FACT checks: everything about a generated app that can be
 * decided by looking things up rather than by judgement — the document parses
 * and validates, its queries name tools the host really has, its nodes name
 * components the catalog really carries, and its bindings reach fields the
 * tool shapes really expose with types the props really accept.
 *
 * These helpers are the single home for that machinery. The create/edit
 * validator (generation/validation/validate.ts) flattens the same anchored
 * issues into its own issue strings, so there is one implementation and one
 * message per fact for as long as both callers exist.
 *
 * Judgement checks (invented data, dishonest tool use, dead buttons, sections
 * that miss the ask) are NOT here — they belong to the AI reviewer.
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  WIRE_COMPONENT_NAMES,
  VENDO_TREE_FORMAT,
  checkBindingShapes,
  checkExpr,
  kitSpec,
  printWire,
  shapeAtPointer,
  isExprBinding,
  isPathBinding,
  isStateBinding,
  validateAppDocument,
  validateTree,
  type NormalizedCatalog,
  type ShapeType,
  type Tree,
  type TreeNode,
} from "@vendoai/core";
import type { AppDocument } from "@vendoai/core";
import { prewiredPropNames } from "../prewired-schema.js";
import type { FloorDependencies, HostToolInfo } from "./deps.js";
import { screenTypings } from "./screen-typings.js";
import { screenTscFindings } from "./screen-tsc.js";
import type { Check, Finding } from "./types.js";

/** The app's name is its panel display title. Echoing the ask back ("Create a
 *  chat dashboard that displays the user's…") ships a truncated sentence as
 *  the title of every fresh install's first app, so the cap is a validation
 *  gate, not just prompt guidance: an over-long name routes to repair with
 *  the message below. Create-only — stored apps with long names keep editing
 *  fine (the edit path never re-validates the name).
 *
 *  It lives HERE, with the check that enforces it, rather than with the prompt
 *  sections that used to declare it: the floor must not import the generation
 *  pipeline (§7.3). */
export const APP_NAME_MAX_CHARS = 40;

/** One fact issue, anchored: `where` is the locus, `message` continues the
 *  sentence from it. Read as one line (`node "n3" prop "rows" binds …`) they
 *  are the validator's issue strings; read as a pair they are a {@link Finding}. */
export interface FactIssue {
  where: string;
  message: string;
}

/** The validator's flat issue-string form of an anchored fact issue. */
export const factIssueLine = ({ where, message }: FactIssue): string => `${where} ${message}`;

const atNode = (nodeId: string, message: string): FactIssue => ({ where: `node "${nodeId}"`, message });
const atProp = (nodeId: string, prop: string, message: string): FactIssue =>
  ({ where: `node "${nodeId}" prop "${prop}"`, message });

const reserved = new Set<string>(WIRE_COMPONENT_NAMES);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isActionBinding = (value: unknown): boolean =>
  isRecord(value) && typeof value.action === "string";

export const isRuntimeBound = (value: unknown): boolean =>
  isPathBinding(value) || isStateBinding(value) || isExprBinding(value) || isActionBinding(value);

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
 *  the wire compiler's shape check; this catches the type mismatches that
 *  render silently broken (empty chart, blank stat). */
export const bindingKindIssues = (tree: Tree, deps: FloorDependencies): FactIssue[] => {
  if (deps.toolShapes === undefined) return [];
  const issues: FactIssue[] = [];
  const queryTool = new Map((tree.queries ?? []).map((query) => [query.name, query.tool]));
  const hostSchemas = new Map(deps.catalog.map((component) => [component.name, component.propsJsonSchema]));
  for (const node of tree.nodes) {
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
        issues.push(atProp(node.id, prop, `binds ${value.$path}: ${mismatch} — bind a field whose shape matches the component's prop type`));
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

export const hostReshapeIssues = (tree: Tree, deps: FloorDependencies): FactIssue[] => {
  const issues: FactIssue[] = [];
  const hostSchemas = new Map(deps.catalog.map((component) => [component.name, component.propsJsonSchema]));
  for (const node of tree.nodes) {
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
      issues.push(atProp(node.id, prop, `reshapes with asPoints/asOptions, but host component "${node.component}" declares its own item fields (${itemProperties.join(", ")}) — it cannot read generic {label, value} items. Bind the RAW rows (drop the reshape) so the component receives the fields its schema names.`));
    }
  }
  return issues;
};

/** Law 2 — a query input executes as LITERAL JSON: the runtime never
 *  resolves bindings inside it, so a dependent call
 *  (`accountId: accounts.data.0.id`) reaches the tool as an unresolved
 *  binding object and the app ships broken. Reject at compile → repair. */
export const queryInputIssues = (tree: Tree): FactIssue[] => {
  const issues: FactIssue[] = [];
  const findBinding = (value: unknown): boolean => {
    if (isPathBinding(value) || isStateBinding(value) || isExprBinding(value)) return true;
    if (Array.isArray(value)) return value.some(findBinding);
    if (isRecord(value)) return Object.values(value).some(findBinding);
    return false;
  };
  for (const query of tree.queries ?? []) {
    if (query.input !== undefined && findBinding(query.input)) {
      issues.push({
        where: `query "${query.name}"`,
        message: `(tool "${query.tool}") embeds a binding in its input — query inputs must be LITERAL JSON the tool can execute directly; another query's result can never feed a query input. Use a literal value (or drop the optional input), or build the dependent lookup inside an <Island> with ambient tools.`,
      });
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

export const kitSlotIssues = (tree: Tree, deps: FloorDependencies): FactIssue[] => {
  if (deps.toolShapes === undefined) return [];
  const issues: FactIssue[] = [];
  const queryTool = new Map((tree.queries ?? []).map((query) => [query.name, query.tool]));
  for (const node of tree.nodes) {
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
        issues.push(atProp(node.id, prop, `on <${node.component}> binds ${value.$path}, a ${bound.kind} field, but this slot takes a different RAW type (${propSpec.doc}) — bind the raw field with that type (e.g. the integer-cents field, not a pre-formatted display string).`));
      }
    }
  }
  return issues;
};

/** A computed value (`{ $expr }`) is evaluated live in the renderer, so a bad
 *  expression is a blank stat rather than a crash — exactly the silent-breakage
 *  class facts exist to catch. Three kinds are decidable by looking things up:
 *  the expression parses, its field paths reach fields the tool shapes really
 *  expose, and every slot's type can compute (sum over a string cannot).
 *  Whether the number MEANS anything is the reviewer's judgement, not a fact. */
export const exprIssues = (tree: Tree, deps: FloorDependencies): FactIssue[] => {
  const queryTool = new Map((tree.queries ?? []).map((query) => [query.name, query.tool]));
  const context = {
    queryNames: [...queryTool.keys()],
    shapeOf: (queryName: string) => {
      const tool = queryTool.get(queryName);
      return tool === undefined || deps.toolShapes === undefined ? undefined : deps.toolShapes[tool];
    },
  };
  const issues: FactIssue[] = [];
  const walk = (nodeId: string, prop: string, value: unknown): void => {
    if (isExprBinding(value)) {
      for (const message of checkExpr(value.$expr, context)) {
        issues.push(atProp(nodeId, prop, `computes {${value.$expr}}: ${message}`));
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
  for (const node of tree.nodes) {
    for (const [prop, value] of Object.entries(node.props ?? {})) walk(node.id, prop, value);
  }
  return issues;
};

/** Models write "Total: {metric.total}" inside STRING attributes; the wire
 *  has no string interpolation, so the braces render literally. Any string
 *  prop embedding a declared query reference is a repair-routed error. */
export const interpolationIssues = (tree: Tree): FactIssue[] => {
  const queryNames = (tree.queries ?? []).map((query) => query.name);
  if (queryNames.length === 0) return [];
  const pattern = new RegExp(`\\{(?:${queryNames.join("|")})(?:\\.[A-Za-z0-9_]+)*\\}`);
  const issues: FactIssue[] = [];
  const walk = (nodeId: string, prop: string, value: unknown): void => {
    if (typeof value === "string") {
      if (pattern.test(value)) {
        issues.push(atProp(nodeId, prop, "embeds a binding inside a string — string interpolation is unsupported; bind the prop to a single {reference} or split the text into separate Text nodes"));
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
  for (const node of tree.nodes) {
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
): Promise<FactIssue[]> => {
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
      return [atNode(node.id, `props invalid for host component "${component.name}"${location}: ${issueMessage(issue)}`)];
    });
  } catch (error) {
    return [atNode(node.id, `props validation failed for host component "${component.name}": ${error instanceof Error ? error.message : "unknown schema error"}`)];
  }
};

/** Prewired primitives are handed to the model by name plus an exact prop
 *  signature (prewired-schema.ts). The compiler keeps any attribute the model
 *  writes, so a wrong name (`data` for Table's `rows`, `onPress` for Button's
 *  `onClick`) survives into props and the renderer silently ignores it — the
 *  "valid table, empty rows" class. Reject unknown prop names so the model
 *  repairs to the real one instead of shipping a dead component. */
const prewiredPropsIssues = (node: TreeNode): FactIssue[] => {
  const allowed = prewiredPropNames.get(node.component);
  const props = node.props;
  if (allowed === undefined || props === undefined) return [];
  return Object.keys(props)
    // `pending` is the renderer's own placeholder cue, not a component prop —
    // the plan skeleton writes it on every leaf (generation/skeleton.ts) and a
    // section whose fill honestly failed keeps it.
    .filter((name) => name !== "pending" && !allowed.has(name))
    .map((name) => atNode(node.id, `sets unknown prop "${name}" on prewired component "${node.component}"; the renderer drops it. Allowed props: ${[...allowed].join(", ") || "(none)"}`));
};

export const catalogIssues = async (
  tree: Tree,
  components: Record<string, string> | undefined,
  catalog: NormalizedCatalog,
): Promise<FactIssue[]> => {
  const hostCatalog = new Map(catalog.map((component) => [component.name, component]));
  const hostNames = new Set(hostCatalog.keys());
  const generatedNames = new Set(Object.keys(components ?? {}));
  const issues: FactIssue[] = [];
  for (const node of tree.nodes) {
    if (node.source === "host") {
      const component = hostCatalog.get(node.component);
      if (component === undefined) {
        issues.push(atNode(node.id, `references host component "${node.component}" absent from the catalog`));
      } else {
        issues.push(...await hostPropsIssues(node, component));
      }
    } else if (node.source === "prewired") {
      if (!reserved.has(node.component)) {
        issues.push(atNode(node.id, `references unknown prewired component "${node.component}"`));
      } else {
        issues.push(...prewiredPropsIssues(node));
      }
    } else if (node.source === "generated" && !generatedNames.has(node.component)) {
      issues.push(atNode(node.id, `references generated component "${node.component}" without source`));
    } else if (node.source === undefined) {
      // Legacy/direct trees can omit source; the renderer resolves the name to
      // a prewired primitive first, so a reserved name here gets the same
      // prop-name gate as an explicit source:"prewired" node — otherwise a
      // stored tree could still ship an ignored prop (e.g. Table.data).
      if (reserved.has(node.component)) {
        issues.push(...prewiredPropsIssues(node));
      } else if (!hostNames.has(node.component) && !generatedNames.has(node.component)) {
        issues.push(atNode(node.id, `references unknown component "${node.component}"`));
      }
    }
  }
  return issues;
};

/** A query naming a tool the host does not have. The message lists the real
 *  ones — a model reading it can pick, and a human reading it learns the
 *  surface. `fn:` queries are the app's own server code, not host tools. */
export const unknownToolIssues = (tree: Tree, tools: readonly HostToolInfo[] | undefined): FactIssue[] => {
  if (tools === undefined) return [];
  const known = new Set(tools.map((tool) => tool.name));
  return (tree.queries ?? [])
    .filter((query) => !query.tool.startsWith("fn:") && !known.has(query.tool))
    .map((query) => ({
      where: `query "${query.name}"`,
      message: `names unknown tool "${query.tool}"; the host tools are: ${[...known].join(", ")}`,
    }));
};

/** Every `$path` binding resolved query → tool → response shape by the wire
 *  compiler's own checker. A miss carries the fields that ARE there, so the
 *  message can teach instead of only refusing.
 *
 *  KEPT despite the tsc floor: a `$path` with a NUMERIC index segment
 *  (`/invoices/data/0/customer`) does not print as a bare reference — printWire
 *  falls to a quoted `{ "$path": … }` object literal (identifier segments only,
 *  print.ts), which tsc reads as a valid object and cannot walk. So field
 *  existence UNDER an index is the one field-existence class the static half
 *  cannot see; this check is its only reader. Identifier-path field existence
 *  overlaps `screen-types` — both block, and `screen-types` runs last so its
 *  message trails the targeted one. */
const bindingShapeIssues = (tree: Tree, deps: FloorDependencies): FactIssue[] => {
  if (deps.toolShapes === undefined) return [];
  return checkBindingShapes(tree.nodes, tree.queries ?? [], deps.toolShapes).map((error) => atProp(
    error.nodeId,
    error.prop,
    `binds ${error.path}: ${error.message}${error.available === undefined ? "" : ` — the real fields are: ${error.available.join(", ")}`}`,
  ));
};

/** The document's own validity: it parses as an app, its tree is a tree of the
 *  format this engine speaks, and it carries a short human title. */
const documentIssues = (app: AppDocument): FactIssue[] => {
  const issues: FactIssue[] = [];
  const name = app.name?.trim() ?? "";
  if (name === "") {
    issues.push({ where: "document", message: 'must carry a non-empty name="..." attribute' });
  } else if (name.length > APP_NAME_MAX_CHARS) {
    issues.push({ where: "document", message: `name="${name}" is ${name.length} characters — name is the app's display title (at most ${APP_NAME_MAX_CHARS} characters); write a short human title, never the request echoed back` });
  }
  const validation = validateAppDocument(app);
  if (!validation.ok) issues.push({ where: "document", message: validation.error.message });
  if (app.tree === undefined) {
    issues.push({ where: "document", message: "carries no tree — the engine emits tree documents only" });
    return issues;
  }
  if (app.tree.formatVersion !== VENDO_TREE_FORMAT) {
    issues.push({ where: "document", message: `carries tree format "${String(app.tree.formatVersion)}" — this engine speaks "${VENDO_TREE_FORMAT}"` });
    return issues;
  }
  const treeValidation = validateTree(app.tree);
  if (!treeValidation.ok) issues.push({ where: "document", message: treeValidation.error.message });
  return issues;
};

/** The document's tree, or undefined when it is not one — the `document`
 *  check reports that, and every other check stays quiet rather than
 *  repeating it. */
export const treeOf = (app: Pick<AppDocument, "tree">): Tree | undefined => {
  if (app.tree === undefined || app.tree.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  const validation = validateTree(app.tree);
  return validation.ok ? validation.tree : undefined;
};

const blocking = (issues: readonly FactIssue[]): Finding[] =>
  issues.map(({ where, message }) => ({ severity: "block", where, message }));

/** A check over the document's tree; skipped silently when there is no valid
 *  tree to look at. */
const treeCheck = (
  name: string,
  issues: (tree: Tree, app: AppDocument) => FactIssue[] | Promise<FactIssue[]>,
): Check => ({
  name,
  kind: "fact",
  run: async ({ document }) => {
    const tree = treeOf(document);
    return tree === undefined ? [] : blocking(await issues(tree, document));
  },
});

/**
 * The checks floor's static half: the screen's own text, type-checked by `tsc`
 * against the declarations the floor already holds (screen-typings.ts). One
 * compiler answers "does this file name a surface it may, with props that exist,
 * types that fit, and data fields the response really carries" — the question
 * the bespoke component/binding walkers answer by hand. It degrades to silence
 * when no compiler is reachable (screen-tsc.ts), so a missing toolchain never
 * blocks a build.
 *
 * It FULLY replaces the type-mismatch binding walker (`bindingKindIssues` is
 * dropped from the check list here) and OVERLAPS the component-existence, host-
 * prop and field-existence walkers, which stay: the (quarantined) fill fix loop
 * attributes findings by `node "id"` locus and tsc anchors on `<Component>`
 * tags, and a numeric-index path (`data.0.field`) prints as an opaque `$path`
 * literal tsc cannot walk. Those two are the subsumption's real edges; the
 * bespoke walkers cover them until the quarantine sweep reconciles the loci.
 *
 * The screen text is RECONSTRUCTED from the tree with `printWire`: the tree
 * round-trips to wire byte-identically (#808) and the wire is a strict TSX
 * subset, so the reconstruction is exactly what tsc reads. Islands are printed
 * OUT (`components: {}`): their source is React, checked by the smoke-render
 * gate, not screen wire, and feeding it to tsc is a parse error. Their NAMES
 * ride along as schema-less vocabulary — a generated node WITH a source is not
 * misread as an unknown component, and one WITHOUT a source is still flagged,
 * exactly as the `components-exist` generated branch does.
 */
const screenTypeFindings = (tree: Tree, document: AppDocument, deps: FloorDependencies): Finding[] => {
  const queries = (tree.queries ?? []).map((query) => ({ name: query.name, tool: query.tool }));
  const generated = Object.keys(document.components ?? {}).map((name) => ({ name, description: "generated component" }));
  const typings = screenTypings({
    catalog: [...deps.catalog, ...generated],
    queries,
    toolShapes: deps.toolShapes,
  });
  const screen = printWire({ tree, components: {}, name: document.name }, { includeIds: false });
  return screenTscFindings({ screen, typings });
};

/**
 * The built-in fact checks, bound to the host surface they measure against.
 * Every finding is `block`: a fact is not a matter of taste.
 */
export const factChecks = (deps: FloorDependencies): Check[] => [
  { name: "document", kind: "fact", run: async ({ document }) => blocking(documentIssues(document)) },
  treeCheck("tools-exist", (tree) => unknownToolIssues(tree, deps.tools)),
  treeCheck("components-exist", (tree, document) => catalogIssues(tree, document.components, deps.catalog)),
  treeCheck("bindings-fit", (tree) => [
    ...bindingShapeIssues(tree, deps),
    ...kitSlotIssues(tree, deps),
    ...hostReshapeIssues(tree, deps),
  ]),
  treeCheck("expressions-compute", (tree) => exprIssues(tree, deps)),
  treeCheck("query-inputs-literal", (tree) => queryInputIssues(tree)),
  treeCheck("no-string-interpolation", (tree) => interpolationIssues(tree)),
];

/**
 * The cheap structural type-mismatch check — a binding's shape KIND against the
 * host prop's declared type (`shapeSchemaMismatch`). It is node-anchored, so the
 * conductor's fix-loop can act on it; the compiler static half's findings are
 * tag-anchored and it cannot.
 *
 * It is NOT in `factChecks`. It runs on the GENERATE path (conductor, fill),
 * where a synchronous, fix-loop-consumable type check is what the loop needs and
 * a compiler program would blow the create latency budget (`gen-scripted:create`,
 * measured: the tsc pass alone is ~3ms of a ~4ms create). At the floor and the
 * validate door the compiler static half (`screenTypesCheck`) covers this class
 * and more, so neither path runs both — one type check each, the right one.
 */
export const bindingKindCheck = (deps: FloorDependencies): Check =>
  treeCheck("bindings-fit-kind", (tree) => bindingKindIssues(tree, deps));

/**
 * The compiler static half (§7.1 + Track A): a `tsc` program over the printed
 * screen + generated typings. It spins a compiler, so it runs ONLY where a bad
 * screen is blocked from a user and the cost is affordable — the paint-seam floor
 * and the validate door — never inside the synchronous scripted-create loop the
 * perf gate guards. Degrades to silence when no compiler is available.
 */
export const screenTypesCheck = (deps: FloorDependencies): Check => ({
  name: "screen-types",
  kind: "fact",
  run: async ({ document }) => {
    const tree = treeOf(document);
    return tree === undefined ? [] : screenTypeFindings(tree, document, deps);
  },
});
