/**
 * The built-in FACT checks: everything about a stored app that can be decided by
 * looking things up rather than by judgement — the document parses, validates,
 * and carries the `app.tsx` that IS the app.
 *
 * The walkers beside them read a RENDERED tree: node names against the catalog,
 * nesting, routes, prop shapes. They are the component gauntlet's
 * (`component-screen.ts`), which runs them over the tree a paint just produced —
 * the only tree there is.
 *
 * Judgement checks (invented data, dishonest tool use, dead buttons, sections
 * that miss the ask) are NOT here — they belong to the AI reviewer.
 */
import {
  isPathBinding,
  isStateBinding,
  type TreeNode,
} from "@vendoai/core";
import {
  DISPLAY_TAG_NAMES,
  KIT_CHILDLESS_NAMES,
  KIT_SCREEN_COMPONENT_NAMES,
  kitSlotPath,
  kitSpec,
  isExprBinding,
  validateAppDocument,
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
import type { FloorDependencies } from "./deps.js";
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
 * Where an element may be WRITTEN — the rule the RENDERER cannot state. The tree
 * renderer hands `children` to every node it renders (`packages/ui`
 * renderer.tsx `builtinContent`), and reads an element only at the props a
 * component actually paints, so a chart handed a child, or an element written at
 * a key that is no slot, has always painted as nothing at all: the model wrote
 * content, the person got a blank, and no stage said a word. WHAT goes in a slot
 * is not measured here — any Kit element may sit in any slot, the way it may in
 * normal React, and whether it belongs there is the judge's to grade.
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

  /** One slot: the element it holds, and every element nested in that one. WHAT
   *  it holds is not gated — any Kit element may sit in any slot, the way it may
   *  in normal React — but what sits there is a component in its own right, with
   *  its own slots and its own childless contract. Unmeasured, `<Stack
   *  header={<Text/>}/>` and a `<DataTable>` handed children both passed while
   *  the renderer dropped the descendant. */
  const checkSlot = (nodeId: string, path: string, slot: KitSlotSpec, value: unknown, sigil = true, parent?: string): void => {
    // A per-row slot written as a function of the row emits one element PER ROW,
    // so the LIST is where the elements are (`vm-program.ts` `emitSlot`).
    if (slot.perRow === true && Array.isArray(value)) {
      value.forEach((row, index) => checkSlot(nodeId, `${path}[${index}]`, slot, row, sigil, parent));
      return;
    }
    const element = asElement(value, sigil);
    if (element === undefined) return;
    // A NAME, not a vocabulary: the renderer resolves a slot's element from the
    // Kit and the display bricks and paints nothing for a name in neither
    // (`packages/ui` renderer.tsx `reifyElement`), so an unresolvable one is
    // refused here instead of arriving as a blank.
    if (kitSpec(element.component) === undefined && !DISPLAY_TAG_NAMES.includes(element.component)) {
      issues.push(atProp(nodeId, path, `holds <${element.component}>, and no Kit component or display tag has that name — the renderer paints nothing for a name it cannot resolve.`));
    }
    checkKitElement(nodeId, path, element.component, element.props, element.children, parent);
    if (Array.isArray(element.children)) {
      element.children.forEach((child, index) => checkSlot(nodeId, `${path}.children[${index}]`, slot, child, false, element.component));
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
    slots: ReadonlyMap<string, KitSlotSpec>,
    path: string,
    shape: string,
    value: unknown,
  ): void => {
    const slot = slots.get(shape);
    if (slot !== undefined) {
      checkSlot(nodeId, path, slot, value);
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
    const spec = kitSpec(component);
    const kids: unknown[] = Array.isArray(children) ? children : [];
    // A <Button> with no `label` really renders its children (`label ?? children`,
    // packages/ui kit/forms/button.tsx) — the shape the splitter's <button>
    // rewrite emits. Unreachable from the authored dialect, whose typings keep
    // `label` required, so nothing a model writes gains a nesting it never had.
    const rendersKids = component === "Button" && !(isRecord(props) && props["label"] !== undefined);
    if (kids.length > 0 && CHILDLESS.has(component) && !rendersKids) {
      // The generic tail is true of every leaf and useful for almost none of
      // them, so a component whose own answer is not obvious names it
      // (`KitComponentSpec.childrenFix` — <Menu>'s entries are data plus one
      // handler, and the refusal used to leave the model to guess that).
      const fix = spec?.childrenFix
        ?? `Put it beside <${component}> in a <Stack>, or give <${component}> what it showed through its own props.`;
      issues.push(anchor(`nests ${kids.length === 1 ? "1 node" : `${kids.length} nodes`} inside <${component}>, which renders nothing nested inside it: that content never reaches the screen. ${fix}`));
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
    if (spec === undefined || !isRecord(props)) return;
    // TWO props for one job, where the component honours one and drops the other
    // (`KitComponentSpec.exclusive`). Each is valid alone, so no schema can fail
    // the pair — and the one that loses loses in silence, which is the class this
    // whole walk exists for.
    for (const { props: rivals, fix } of spec.exclusive ?? []) {
      const written = rivals.filter((name) => Object.hasOwn(props, name) && props[name] !== undefined);
      if (written.length < 2) continue;
      issues.push(anchor(`writes ${written.map((name) => `"${name}"`).join(" and ")} together on <${component}>, which paints only one of them and drops the rest without a word. ${fix}`));
    }
    // A Map, not the record: a prop key is model-written, and `slots["toString"]`
    // on a plain object answers with Object's own.
    const slots = new Map(Object.entries(spec.slots ?? {})
      .map(([name, slot]) => [kitSlotPath(name, slot), slot] as const));
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
  // An app IS its `app.tsx`, and its tree is what RENDERING that produces — the
  // screen's own gauntlet (`checkComponentScreen`) is the mechanical half. A
  // document with no screen has no app in it.
  if (app.source?.[SCREEN_FILE] === undefined) {
    issues.push({ where: "document", message: "carries no screen — an app is its own app.tsx" });
  }
  return issues;
};

const blocking = (issues: readonly FactIssue[]): Finding[] =>
  issues.map(({ where, message }) => ({ severity: "block", where, message }));

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
 * The built-in fact checks. Every finding is `block`: a fact is not a matter of
 * taste.
 */
export const factChecks = (): Check[] => [
  { name: "document", kind: "fact", run: async ({ document }) => blocking(documentIssues(document)) },
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
