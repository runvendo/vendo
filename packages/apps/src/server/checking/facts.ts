/**
 * The built-in FACT checks: everything about a generated app that can be
 * decided by looking things up rather than by judgement — the document parses
 * and validates, its queries name tools the host really has, its nodes name
 * components the catalog really carries, and its bindings reach fields the
 * tool shapes really expose with types the props really accept.
 *
 * These helpers are the single home for that machinery.
 *
 * Judgement checks (invented data, dishonest tool use, dead buttons, sections
 * that miss the ask) are NOT here — they belong to the AI reviewer.
 */
import {
  VENDO_TREE_FORMAT,
  shapeAtPointer,
  isPathBinding,
  isStateBinding,
  type ShapeType,
  type TreeNode,
} from "@vendoai/core";
import {
  DISPLAY_TAG_NAMES,
  KIT_CHILDLESS_NAMES,
  KIT_SLOT_CONTENT_NAMES,
  KIT_SCREEN_COMPONENT_NAMES,
  checkBindingShapes,
  checkExpr,
  kitSlotPath,
  kitSpec,
  isExprBinding,
  validateAppDocument,
  validateTree,
  vendoRouteParams,
  type KitSlotSpec,
  type NormalizedCatalog,
  type Tree,
  type VendoRouteMap,
} from "../../contract/index.js";
import type {
  AppDocument,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import { wirePropNames } from "../escalation/prewired-schema.js";
import type { FloorDependencies, HostToolInfo } from "./deps.js";
import { COMPONENT_SCREEN_LIB, componentScreenTypings, screenCatalog } from "./screen-typings.js";
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

const reserved = new Set<string>(KIT_SCREEN_COMPONENT_NAMES);

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

/** With the tools' declared response shapes AND the catalog's prop schemas both
 *  in hand, a top-level `$path` prop on a host node can be kind-checked end to
 *  end. Existence is the wire compiler's shape check; this catches the type
 *  mismatches that render silently broken (empty chart, blank stat). */
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
        message: `(tool "${query.tool}") embeds a binding in its input — query inputs must be LITERAL JSON the tool can execute directly; another query's result can never feed a query input. Use a literal value (or drop the optional input), and derive what you needed where it is DISPLAYED instead: a component's prop is a JavaScript expression over the queries you already declared (rows={${query.name}.data.filter(r => r.status === "open")}).`,
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

/** The value a slot's zod schema is probed with. A DECLARED enum probes with
 *  one of its OWN values: `"probe"` through a `"paid" | "void"` slot fails a
 *  binding the host's contract actually permits. */
const probeFor = (shape: ShapeType): unknown =>
  "enum" in shape && shape.enum !== undefined && shape.enum.length > 0
    ? shape.enum[0]
    : KIND_PROBES[shape.kind];

const KIT_SCREEN_SET: ReadonlySet<string> = new Set(KIT_SCREEN_COMPONENT_NAMES);

export const kitSlotIssues = (tree: Tree, deps: FloorDependencies): FactIssue[] => {
  if (deps.toolShapes === undefined) return [];
  const issues: FactIssue[] = [];
  const queryTool = new Map((tree.queries ?? []).map((query) => [query.name, query.tool]));
  for (const node of tree.nodes) {
    if (node.source === "host" || node.source === "generated" || node.props === undefined) continue;
    if (!KIT_SCREEN_SET.has(node.component)) continue;
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
      const probe = probeFor(bound);
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
 *  class facts exist to catch. Two kinds are decidable by looking things up: the
 *  expression is a JavaScript expression within the size cap, and every name it
 *  reads is a query the screen declared.
 *
 *  Its FIELDS and TYPES are the `screen-types` check's, not this one's: the gap
 *  is real JavaScript now, so the printed screen type-checks against the
 *  queries' declared result types under the real compiler. A second bespoke
 *  shape walker here could only disagree with it. Whether the number MEANS
 *  anything stays the reviewer's judgement.
 *
 *  `_deps` is vestigial: the shape lookup it carried is what moved to the
 *  compiler. It stays in the signature only because the create/edit validator
 *  (generation/validation/validate.ts) passes it, and that file is off-limits
 *  to this change — drop the argument there and the parameter here together. */
export const exprIssues = (tree: Tree, _deps?: FloorDependencies): FactIssue[] => {
  const context = { queryNames: (tree.queries ?? []).map((query) => query.name) };
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

/** Built-in components are handed to the model by name plus their exact prop
 *  schemas (the Kit specs, via prewired-schema.ts). The compiler keeps any
 *  attribute the model writes, so a wrong name (`data` for DataTable's `rows`,
 *  `onPress` for Button's `onClick`) survives into props and the renderer
 *  silently ignores it — the "valid table, empty rows" class. Reject unknown
 *  prop names so the model repairs to the real one instead of shipping a dead
 *  component.
 *
 *  A component that RENDERS an engine is exempt: the undeclared name there
 *  reaches recharts or Base UI and paints, so refusing it would refuse working
 *  code (`KitComponentSpec.engine`). */
const prewiredPropsIssues = (node: TreeNode): FactIssue[] => {
  const allowed = wirePropNames.get(node.component);
  const props = node.props;
  if (allowed === undefined || props === undefined) return [];
  if (kitSpec(node.component)?.engine !== undefined) return [];
  return Object.keys(props)
    // `pending` is the renderer's own placeholder cue, not a component prop —
    // the plan skeleton writes it on every leaf (generation/skeleton.ts) and a
    // section whose fill honestly failed keeps it.
    .filter((name) => name !== "pending" && !allowed.has(name))
    .map((name) => atNode(node.id, `sets unknown prop "${name}" on prewired component "${node.component}"; the renderer drops it. Allowed props: ${[...allowed].join(", ") || "(none)"}`));
};

export const catalogIssues = async (
  tree: Tree,
  /** Names only — the generated map's KEYS are the vocabulary this check
   *  measures against, so an entry's shape is none of its business. */
  components: Record<string, unknown> | undefined,
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

const CHILDLESS: ReadonlySet<string> = new Set(KIT_CHILDLESS_NAMES);
/** The one brick that takes a route (`kit/specs.ts`). Pinned to its spec by the
 *  route check's own test, so renaming the brick cannot leave this behind. */
const KIT_LINK = "Link";
/** The one brick whose CHILDREN are records, and the row that is one of them
 *  (`kit/specs.ts`). Pinned to their specs by the row check's own test. */
const KIT_TABLE = "DataTable";
const KIT_TABLE_ROW = "TableRow";

/** A Kit element sitting in a PROP — what a slot holds. The screen VM
 *  stamps the SLOT's own element `$element` and leaves the ones nested under it
 *  bare (genui/component/vm-program.ts `emitValue`), and the renderer reifies on
 *  exactly that (`packages/ui` renderer.tsx `reifyElement`) — so this reads the
 *  sigil at the slot and a `component` name below it, and a data row that merely
 *  carries a "component" field is never mistaken for an element. */
const asElement = (value: unknown, sigil: boolean): { component: string; props?: unknown; children?: unknown } | undefined =>
  isRecord(value) && typeof value.component === "string" && (!sigil || value.$element === true)
    ? (value as { component: string; props?: unknown; children?: unknown })
    : undefined;

/**
 * What may be nested where — the rule the RENDERER cannot state. The tree
 * renderer hands `children` to every node it renders (`packages/ui`
 * renderer.tsx `builtinContent`), so a chart handed a child, or a Button
 * dropped into a table cell, has always painted as nothing at all: the model
 * wrote a control, the person got a blank, and no stage said a word.
 *
 * One function, both artifacts: a wire tree and the tree a `.tsx` screen paints
 * are the same tree and reach the same renderer, so this is a check in the wire
 * floor (`kit-nesting`) and a stage of the component-screen gauntlet
 * (`nesting`), never two implementations that could disagree.
 *
 * A `host`/`generated` node is somebody else's implementation, which may nest
 * whatever it likes — only a name the renderer resolves to the Kit is measured.
 */
export const kitNestingIssues = (tree: Tree): FactIssue[] => {
  const issues: FactIssue[] = [];

  /** A child in the two forms this walk meets: a tree node names its children by
   *  id, an element in a prop carries them whole. */
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const childOf = (child: unknown): { component: string; children?: unknown } | undefined =>
    typeof child === "string" ? byId.get(child) : asElement(child, false);
  /** Who a node hangs under — the one thing a node cannot say about itself, and
   *  the whole of what makes a <TableRow> a row. */
  const parents = new Map(tree.nodes.flatMap((node) =>
    (node.children ?? []).map((id) => [id, node.component] as const)));

  /** One slot: the element it holds, and every element nested in that one. A
   *  slot with no declared vocabulary takes the read-only value tier, and a
   *  per-row one says WHY that tier is the one it takes.
   *
   *  A DISPLAY BRICK passes every slot, and is stated here rather than added to
   *  each vocabulary: these lists gate BEHAVIOR — what may sort, submit or call a
   *  tool where there is no row to act on — and a brick has none to gate. It is
   *  arrangement and typography, `style` and children and nothing else
   *  (`contract/kit/display.ts`), so it can no more break the per-row rule than a
   *  word can. */
  const checkSlot = (nodeId: string, path: string, name: string, slot: KitSlotSpec, value: unknown, sigil = true, parent?: string): void => {
    const element = asElement(value, sigil);
    if (element === undefined) return;
    const allowed = slot.content ?? KIT_SLOT_CONTENT_NAMES;
    if (!allowed.includes(element.component) && !DISPLAY_TAG_NAMES.includes(element.component)) {
      const why = slot.perRow === true && slot.content === undefined
        ? `a cell is read, never operated: the slot is written ONCE and rendered for every row, so nothing in it has a row of its own to act on. A cell may hold: ${allowed.join(", ")} — each reading its row's value with field="…". Anything else belongs beside the table, not in it.`
        : `this slot may hold: ${allowed.join(", ")}.`;
      issues.push(atProp(nodeId, path, `holds <${element.component}> in a ${name} slot — ${why}`));
    }
    // What sits in a slot is a component in its own right, with its own slots
    // and its own childless contract. Measuring it only against the OUTER
    // slot's vocabulary passes `<Stack header={<Text/>}/>` and a `<DataTable>`
    // handed children — both dropped by the renderer, which is the whole class
    // this check exists to refuse.
    checkKitElement(nodeId, path, element.component, element.props, element.children, parent);
    if (Array.isArray(element.children)) {
      element.children.forEach((child, index) => checkSlot(nodeId, `${path}.children[${index}]`, name, slot, child, false, element.component));
    }
  };

  /** The slots inside one prop. The walk carries the SHAPE of where it stands —
   *  `columns[].cell`, `rows[].cell` — and a slot matches only its own declared
   *  path (`kitSlotPath`). Matching a bare key at any depth admitted
   *  `rows[].cell` on a DataTable that reads `columns[].cell` and nothing else:
   *  legal to the floor, dropped by the component. An element off the declared
   *  paths is a place the renderer paints nothing. */
  const findSlots = (
    nodeId: string,
    component: string,
    slots: ReadonlyMap<string, readonly [string, KitSlotSpec]>,
    path: string,
    shape: string,
    value: unknown,
  ): void => {
    const slot = slots.get(shape);
    if (slot !== undefined) {
      checkSlot(nodeId, path, slot[0], slot[1], value);
      return;
    }
    const stray = asElement(value, true);
    if (stray !== undefined) {
      const has = slots.size === 0
        ? `<${component}> takes no element in its props`
        : `the slots on <${component}> are: ${[...slots.keys()].join(", ")}`;
      issues.push(atProp(nodeId, path, `holds <${stray.component}>, but "${shape}" is not a slot — ${has}. An element written anywhere else is dropped at render.`));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => findSlots(nodeId, component, slots, `${path}[${index}]`, `${shape}[]`, item));
      return;
    }
    if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) {
        findSlots(nodeId, component, slots, `${path}.${name}`, `${shape}.${name}`, item);
      }
    }
  };

  /** One Kit element measured against ITS OWN spec — a tree node, or an element
   *  written into a slot, which is the same thing in a different place. `at` is
   *  where it sits ("" for a node), so a nested component's findings are
   *  anchored at the prop path that leads to it. */
  const checkKitElement = (
    nodeId: string,
    at: string,
    component: string,
    props: unknown,
    children: unknown,
    parent?: string,
  ): void => {
    const anchor = (message: string): FactIssue => at === "" ? atNode(nodeId, message) : atProp(nodeId, at, message);
    const kids: unknown[] = Array.isArray(children) ? children : [];
    if (kids.length > 0 && CHILDLESS.has(component)) {
      issues.push(anchor(`nests ${kids.length === 1 ? "1 node" : `${kids.length} nodes`} inside <${component}>, which renders nothing nested inside it: that content never reaches the screen. Put it beside <${component}> in a <Stack>, or give <${component}> what it showed through its own props.`));
    }
    // WHERE a row sits is the whole of what makes it a row: a <TableRow>'s
    // children are its CELLS, placed in the TABLE's column order (`packages/ui`
    // table-row.tsx). So a row outside a table paints nothing, and a row whose
    // count misses slides every value under the wrong header — both silent.
    if (component === KIT_TABLE_ROW && parent !== KIT_TABLE) {
      issues.push(anchor(`writes <${KIT_TABLE_ROW}> outside a <${KIT_TABLE}> — a table row paints the cells of a table, so on its own it paints nothing at all. Put it inside a <${KIT_TABLE} rows={…} columns={[…]}>, or use <Row> for a horizontal line of components.`));
    }
    if (component === KIT_TABLE && kids.length > 0) {
      // Absent, not merely unreadable: a bound `columns` is somebody else's
      // array, and this rule is about the model that wrote none at all.
      const columns = isRecord(props) ? props.columns : undefined;
      if (columns === undefined) {
        issues.push(anchor(`passes rows as children to <${KIT_TABLE}> with no columns — the columns are what names each header and sets its alignment, and a row's cells are placed in column order. Add columns={[{key:"name",label:"Account"},{key:"balance",label:"Balance",align:"end"}]}.`));
      }
      for (const kid of kids.flatMap((child) => childOf(child) ?? [])) {
        if (kid.component !== KIT_TABLE_ROW) {
          issues.push(anchor(`nests <${kid.component}> in <${KIT_TABLE}> — a table's children are its ROWS, one <${KIT_TABLE_ROW}> per record. Write {rows.map(r => <${KIT_TABLE_ROW} key={r.id}>…</${KIT_TABLE_ROW}>)}, or put this in the table's toolbar={…} slot.`));
          continue;
        }
        const cells = Array.isArray(kid.children) ? kid.children.length : 0;
        if (Array.isArray(columns) && cells !== columns.length) {
          issues.push(anchor(`writes ${cells} cells in a <${KIT_TABLE_ROW}> where <${KIT_TABLE}> has ${columns.length} columns — cells are placed in column order, so the values land under the wrong headers. Write exactly one child per column; wrap several components in a <Stack> to keep them in ONE cell.`));
        }
      }
    }
    const spec = kitSpec(component);
    if (spec === undefined || !isRecord(props)) return;
    // A Map, not the record: a prop key is model-written, and `slots["toString"]`
    // on a plain object answers with Object's own.
    const slots = new Map(Object.entries(spec.slots ?? {})
      .map(([name, slot]) => [kitSlotPath(name, slot), [name, slot] as const]));
    for (const [prop, value] of Object.entries(props)) {
      findSlots(nodeId, component, slots, at === "" ? prop : `${at}.${prop}`, prop, value);
    }
  };

  for (const node of tree.nodes) {
    if (node.source === "host" || node.source === "generated") continue;
    checkKitElement(node.id, "", node.component, node.props ?? {}, node.children, parents.get(node.id));
  }
  return issues;
};

/**
 * A `<Link to>` that will never move anybody.
 *
 * `resolveVendoRoute` answers `undefined` two ways — a name the host never
 * registered, and a registered path whose `:params` the link left unfilled — and
 * the brick renders the SAME dead text for both. That is a silent break of
 * exactly the kind the nesting rule above exists to catch: the model wrote a way
 * out of the screen, the person got dead words, and generation said it passed.
 * So both refusals move to where they can be repaired, and they move together:
 * catching one and not the other would leave a hole precisely where a reader
 * would assume there is none.
 *
 * One function, both artifacts, for the reason `kitNestingIssues` is: a wire tree
 * and the tree a `.tsx` screen paints reach the same renderer.
 *
 * Both messages hand over what the repair needs — the registered names for the
 * first, the unfilled param names for the second — because a link SELECTS from
 * the host's registry and fills its blanks; it never writes a URL.
 */
export const routeIssues = (tree: Tree, routes: VendoRouteMap | undefined): FactIssue[] => {
  if (routes === undefined) return [];
  const names = Object.keys(routes);
  const issues: FactIssue[] = [];
  for (const node of tree.nodes) {
    if (node.component !== KIT_LINK) continue;
    // Own keys only: `to` is model-written, and `routes["toString"]` on a plain
    // object answers with Object's own (the a1-slots reading of the same risk).
    const to = node.props?.to;
    if (typeof to !== "string") continue;
    const route = Object.prototype.hasOwnProperty.call(routes, to) ? routes[to] : undefined;
    if (route === undefined) {
      issues.push(atProp(node.id, "to", `names route "${to}" on <${KIT_LINK}>, which this host never registered — it would render as plain text and go nowhere. ${names.length === 0 ? "This host registered no routes at all, so nothing may link out of a screen; drop the link." : `The registered routes are: ${names.join(", ")}. A link NAMES one of these; it never writes a URL.`}`));
      continue;
    }
    // Read "filled" the way the RESOLVER reads it (`params?.[key] === undefined`),
    // so the floor and the render can never disagree about which links work. The
    // lookup keys come from the host's own path, not from the model.
    const given = node.props?.params as Record<string, unknown> | undefined;
    const takes = vendoRouteParams(route.path);
    const missing = takes.filter((key) => given?.[key] === undefined);
    if (missing.length > 0) {
      issues.push(atProp(node.id, "params", `names route "${to}" on <${KIT_LINK}> but leaves ${missing.map((key) => `"${key}"`).join(", ")} unfilled — that route's path takes ${takes.map((key) => `:${key}`).join(", ")}, and a link missing one of them renders as plain text and goes nowhere. Write params={{ ${missing.map((key) => `${key}: …`).join(", ")} }} beside to="${to}".`));
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
    // …unless the app IS a component screen, whose tree is what rendering it
    // produces rather than anything stored (`SCREEN_FILE` in `source`). Its
    // mechanical half is its own gauntlet (`checkComponentScreen`), so a stored
    // tree would be a snapshot nobody may trust and its absence is not a defect.
    if (app.source?.[SCREEN_FILE] === undefined) {
      issues.push({ where: "document", message: "carries no tree — the engine emits tree documents only" });
    }
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
 * types that fit, and data fields the response really carries". It degrades to
 * silence when no compiler is reachable (screen-tsc.ts), so a missing toolchain
 * never blocks a build.
 *
 * The screen text is the STORED `app.tsx`, verbatim — the same `hash`/`bytes`/
 * `text` triple `commitApp` lands — so a finding's line numbers are the author's
 * own. A document with no screen has nothing to type-check.
 */
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
  treeCheck("kit-nesting", (tree) => kitNestingIssues(tree)),
  treeCheck("routes-exist", (tree) => routeIssues(tree, deps.routes)),
  treeCheck("expressions-compute", (tree) => exprIssues(tree)),
  treeCheck("query-inputs-literal", (tree) => queryInputIssues(tree)),
  treeCheck("no-string-interpolation", (tree) => interpolationIssues(tree)),
];

/**
 * The compiler static half (§7.1 + Track A): a `tsc` program over the stored
 * screen + generated typings. It spins a compiler, so it runs ONLY where a bad
 * screen is blocked from a user and the cost is affordable — the validate door —
 * never inside the synchronous scripted-create loop the perf gate guards.
 * Degrades to silence when no compiler is available.
 */
export const screenTypesCheck = (deps: FloorDependencies): Check => ({
  name: "screen-types",
  kind: "fact",
  run: async ({ document }) => {
    // The screen text VERBATIM, as `commitApp` landed it, so a finding's line
    // numbers are the author's own. No screen, nothing to type-check.
    const screen = document.source?.[SCREEN_FILE]?.text;
    if (screen === undefined || screen.trim() === "") return [];
    return screenTscFindings({
      screen,
      typings: componentScreenTypings({ catalog: screenCatalog(deps.catalog), tools: deps.tools ?? [] }),
      lib: COMPONENT_SCREEN_LIB,
    });
  },
});
