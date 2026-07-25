/**
 * Law 1 — data-classed props must be bindings; a literal there is hand-typed
 * business data. One detector (literalDataFaults), shared by the create/edit
 * validation (literalDataIssues renders the messages) and the
 * structured-repair fix space. The island-side law-1 check (a hand-typed
 * constant feeding displayed math) integrates in islands.ts via
 * islandDerivedValueViolations.
 */
import {
  isPathBinding,
  isStateBinding,
  kitPropClasses,
  KIT_WIRE_COMPONENT_NAMES,
  type NormalizedCatalog,
  type TreeNode,
  type TreeV2,
} from "@vendoai/core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Legacy prewired data props (the Kit carries classes in its specs; the
 *  legacy set is classed here until the legacy primitives retire). */
const LEGACY_DATA_PROPS: Readonly<Record<string, readonly string[]>> = {
  Table: ["rows"],
  Select: ["options"],
  Stat: ["value"],
};

const KIT_WIRE_NAMES: ReadonlySet<string> = new Set(KIT_WIRE_COMPONENT_NAMES);

/** A HOST catalog prop counts as data-classed when its declared JSON-schema
 *  type is a number or an array, its name says business data, and it is not
 *  enum-constrained (enums are config by construction). Strings stay free —
 *  they are labels/copy far more often than data. */
const HOST_DATA_PROP = /(cents|amount|balance|total|value|series|rows|items|data|points|slices|history)/i;

const hostDataProps = (schema: unknown): string[] => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([name, propSchema]) => {
    if (!isRecord(propSchema) || Array.isArray(propSchema.enum)) return [];
    const type = propSchema.type;
    if (type !== "number" && type !== "integer" && type !== "array") return [];
    return HOST_DATA_PROP.test(name) ? [name] : [];
  });
};

/** The data-classed prop names of one node: Kit prop classes for adopted Kit
 *  names, the legacy map for the old prewired set, schema-derived for host
 *  catalog components. */
export const dataClassedProps = (node: TreeNode, catalog: NormalizedCatalog): readonly string[] => {
  if (node.source === "host") {
    const entry = catalog.find((component) => component.name === node.component);
    return hostDataProps(entry?.propsJsonSchema);
  }
  if (node.source === "generated") return [];
  if (KIT_WIRE_NAMES.has(node.component)) {
    const classes = kitPropClasses(node.component);
    return classes === undefined ? [] : Object.entries(classes).flatMap(([prop, cls]) => cls === "data" ? [prop] : []);
  }
  return LEGACY_DATA_PROPS[node.component] ?? [];
};

export interface LiteralDataFault {
  nodeId: string;
  component: string;
  prop: string;
}

const isBindingValue = (value: unknown): boolean => isPathBinding(value) || isStateBinding(value);

/** Law 1 — every data-classed prop present on a node must be a `$path` /
 *  `$state` binding. A literal there is hand-typed business data. */
export const literalDataFaults = (tree: TreeV2, catalog: NormalizedCatalog): LiteralDataFault[] => {
  const faults: LiteralDataFault[] = [];
  for (const node of tree.nodes) {
    const props = node.props;
    if (props === undefined) continue;
    for (const prop of dataClassedProps(node, catalog)) {
      const value = props[prop];
      if (value === undefined || value === null) continue;
      if (isBindingValue(value)) continue;
      faults.push({ nodeId: node.id, component: node.component, prop });
    }
  }
  return faults;
};

/** The repair-facing message for each law-1 fault. */
export const literalDataIssues = (tree: TreeV2, catalog: NormalizedCatalog): string[] =>
  literalDataFaults(tree, catalog).map((fault) =>
    `node "${fault.nodeId}" prop "${fault.prop}" on <${fault.component}> carries hand-typed LITERAL business data — law 1: every data-classed prop must be a binding to a tool result, e.g. ${fault.prop}={queryName.field.path}. If NO host tool provides this data, render an honest <Disclaimer reason="..."/> instead — never invent figures.`);
