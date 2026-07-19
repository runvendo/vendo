/**
 * Internal: the compile-time binding shape check of the vendo-genui/v2 wire
 * compiler (v2 spec §3,
 * docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). Runs as a
 * post-pass over the emitted nodes when the caller supplies `toolShapes`
 * (shape cards keyed by tool): every `$path` binding is resolved query →
 * tool → response shape, walked by pointer, and flowed through its
 * `$reshape` chain. A binding into fields absent from a KNOWN shape is the
 * compile error the spec routes to per-binding repair; unknown tools and
 * `json` regions stay defensive (the renderer's contained notice is the
 * runtime backstop). Only {@link BindingShapeError} is public (root export);
 * the checker itself stays internal.
 */

import { reshapeShape, type ReshapeStep } from "../reshape.js";
import { shapeAtPointer, type ShapeType } from "../shape.js";
import { isPathBinding, isPlainObject, type TreeNode } from "../tree.js";
import type { TreeQueryV2 } from "../tree-v2.js";

/** v2 spec §3 — one per-binding compile error: the repair contract. The
 *  node/prop anchor tells the repair loop WHERE; missing/available tell the
 *  model WHAT to fix. */
export interface BindingShapeError {
  nodeId: string;
  /** The top-level prop the binding lives under (bindings may nest inside
   *  arrays/objects within it). */
  prop: string;
  query: string;
  tool: string;
  /** The binding's full `$path` (query-name-prefixed JSON Pointer). */
  path: string;
  message: string;
  missing?: string[];
  available?: string[];
}

interface MissReport {
  message: string;
  missing?: string[];
  available?: string[];
}

/** Walks the response shape by the binding's sub-pointer, reporting the
 *  first miss with the field context repair needs. `null` miss + `null`
 *  shape means an undecodable pointer segment — treated as unknown, not an
 *  error (validate layers own pointer grammar). */
const walkPointer = (
  shape: ShapeType,
  pointer: string,
): { shape: ShapeType | null; miss: MissReport | null } => {
  let current = shape;
  if (pointer === "") return { shape: current, miss: null };
  for (const encodedToken of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encodedToken)) return { shape: null, miss: null };
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current.kind === "json") return { shape: { kind: "json" }, miss: null };
    if (current.kind === "object") {
      if (!Object.prototype.hasOwnProperty.call(current.fields, token)) {
        return {
          shape: null,
          miss: {
            message: `field "${token}" is absent from the tool's response shape`,
            missing: [token],
            available: Object.keys(current.fields),
          },
        };
      }
      current = current.fields[token] as ShapeType;
      continue;
    }
    if (current.kind === "array") {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        return {
          shape: null,
          miss: { message: `"${token}" indexes into an array in the tool's response shape (expected a numeric index)` },
        };
      }
      current = current.items;
      continue;
    }
    return {
      shape: null,
      miss: { message: `the response shape has a ${current.kind} at this point; "${token}" goes past it` },
    };
  }
  return { shape: current, miss: null };
};

/** Splits a binding `$path` into the query name and the in-response
 *  sub-pointer. Query names are identifier-only (no ~ escapes). */
const splitPath = (path: string): { query: string; pointer: string } | null => {
  if (!path.startsWith("/") || path.length < 2) return null;
  const nextSlash = path.indexOf("/", 1);
  if (nextSlash === -1) return { query: path.slice(1), pointer: "" };
  return { query: path.slice(1, nextSlash), pointer: path.slice(nextSlash) };
};

/** The prewired props whose bound value must be `[{value, label}]` items (a
 *  bare `string[]` is also fine), with the item fields that component requires.
 *  A fetched object array lacking a required field renders blank options/tabs —
 *  the projection gap {@link optionItemMiss} routes to
 *  `| asOptions(valueField, labelField)` repair. Select labels are optional;
 *  Tabs need both (a labelless tab is a blank button). */
const OPTION_ITEM_PROPS: ReadonlyMap<string, { props: ReadonlySet<string>; required: readonly string[] }> = new Map([
  ["Select", { props: new Set(["options"]), required: ["value"] }],
  ["Tabs", { props: new Set(["tabs", "items"]), required: ["value", "label"] }],
]);

/** The item fields the component's option prop requires, or null when
 *  (component, prop) is not an option target. */
const optionRequired = (component: string, prop: string): readonly string[] | null => {
  const entry = OPTION_ITEM_PROPS.get(component);
  return entry !== undefined && entry.props.has(prop) ? entry.required : null;
};

/** The prewired props that render their bound value as TEXT (the display
 *  slots): an object or array landing in one renders raw JSON braces — the
 *  vendo-v2-cells class. Routed to scalar-field / `| template(...)` repair. */
const DISPLAY_TEXT_PROPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Text", new Set(["text"])],
  ["Stat", new Set(["value"])],
  ["Badge", new Set(["label"])],
]);

/** What a checked binding's resolved shape must satisfy for its slot. */
type SlotCheck =
  | { kind: "options"; required: readonly string[] }
  /** A text display slot (Text.text, Stat.value, Badge.label). */
  | { kind: "display"; prop: string }
  /** Table rows: every DISPLAYED column cell must be a scalar. `displayed`
   *  null means every row field shows (the renderer's default). */
  | { kind: "cells"; displayed: ReadonlySet<string> | null };

/** The column keys of a fully-literal Table `columns` prop; null when the
 *  prop is absent or carries bindings/unknown forms — then the renderer
 *  falls back to showing every row field, and so does the check. */
const literalColumnKeys = (columns: unknown): ReadonlySet<string> | null => {
  if (!Array.isArray(columns)) return null;
  const keys = new Set<string>();
  for (const column of columns) {
    if (typeof column === "string") {
      keys.add(column);
    } else if (isPlainObject(column) && typeof (column as { key?: unknown }).key === "string") {
      keys.add((column as { key: string }).key);
    } else {
      return null;
    }
  }
  return keys;
};

const slotFor = (node: TreeNode, prop: string): SlotCheck | null => {
  const required = optionRequired(node.component, prop);
  if (required !== null) return { kind: "options", required };
  if (DISPLAY_TEXT_PROPS.get(node.component)?.has(prop) === true) return { kind: "display", prop };
  if (node.component === "Table" && prop === "rows") {
    return { kind: "cells", displayed: literalColumnKeys(node.props?.columns) };
  }
  return null;
};

/** A non-scalar shape in a text display slot renders raw JSON braces. */
const displaySlotMiss = (shape: ShapeType, prop: string): MissReport | null => {
  if (shape.kind !== "object" && shape.kind !== "array") return null;
  return {
    message: `this binds an ${shape.kind} into the "${prop}" display slot — it renders as raw JSON braces; bind a scalar field instead, or project it to one string with | template("…{field}…") (or an aggregate like | count())`,
    ...(shape.kind === "object" ? { available: Object.keys(shape.fields) } : {}),
  };
};

/** Object/array-valued DISPLAYED columns in Table rows render raw JSON
 *  braces per cell (`{"received":3,"total":6}` — the final-gate class). */
const cellsMiss = (shape: ShapeType, displayed: ReadonlySet<string> | null): MissReport | null => {
  if (shape.kind !== "array" || shape.items.kind !== "object") return null;
  const fields = shape.items.fields;
  const offenders = Object.entries(fields).filter(([field, fieldShape]) =>
    (displayed === null || displayed.has(field)) && (fieldShape.kind === "object" || fieldShape.kind === "array"));
  if (offenders.length === 0) return null;
  const hints = offenders.map(([field, fieldShape]) => {
    const sub = fieldShape.kind === "object" ? Object.keys(fieldShape.fields)[0] : undefined;
    return `| template(${field}, "{${field}${sub === undefined ? "" : `.${sub}`}}")`;
  });
  return {
    message: `these rows carry object-valued column(s) ${offenders.map(([field]) => `"${field}"`).join(", ")} — a Table cell renders an object as raw JSON braces; project each to one string (e.g. ${hints.join(" ")}) or list only scalar keys in columns`,
    available: Object.keys(fields),
  };
};

const slotMiss = (slot: SlotCheck, shape: ShapeType): MissReport | null => {
  if (slot.kind === "options") return optionItemMiss(shape, slot.required);
  if (slot.kind === "display") return displaySlotMiss(shape, slot.prop);
  return cellsMiss(shape, slot.displayed);
};

/** A resolved shape feeding an option prop must be a `string[]` or an object
 *  array carrying the fields that component's items need: Select items are
 *  `{value, label?}` (value required), Tabs items `{value, label}` (both
 *  required — a labelless tab renders a blank button). An object array missing
 *  a required field is the blank-option class; anything else (scalar, json,
 *  non-array) stays defensive. */
const optionItemMiss = (shape: ShapeType, required: readonly string[]): MissReport | null => {
  if (shape.kind !== "array") return null;
  const items = shape.items;
  if (items.kind !== "object") return null;
  const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(items.fields, field));
  if (missing.length === 0) return null;
  const available = Object.keys(items.fields);
  return {
    message: `this binds an array of {${available.join(", ")}}, missing ${missing.map((field) => `"${field}"`).join(", ")}, but the list prop needs [{value, label}] items — project it with | asOptions(valueField, labelField) (e.g. | asOptions(id, name))`,
    available,
  };
};

type BindingCheck =
  | { status: "miss"; query: string; tool: string; report: MissReport }
  /** Resolved cleanly; `shape` is null for unknown/defensive regions. */
  | { status: "ok"; query?: string; tool?: string; shape: ShapeType | null };

const checkBinding = (
  binding: { $path: string; $reshape?: ReshapeStep[] },
  queryTools: ReadonlyMap<string, string>,
  toolShapes: Readonly<Record<string, ShapeType>>,
): BindingCheck => {
  const split = splitPath(binding.$path);
  if (split === null) return { status: "ok", shape: null };
  const tool = queryTools.get(split.query);
  if (tool === undefined) return { status: "ok", shape: null }; // undeclared/dropped query — wave-1 layers own that
  const toolShape = Object.prototype.hasOwnProperty.call(toolShapes, tool)
    ? (toolShapes as Record<string, ShapeType | undefined>)[tool]
    : undefined;
  if (toolShape === undefined) return { status: "ok", shape: null }; // no shape card — Json, defensive
  const walked = walkPointer(toolShape, split.pointer);
  if (walked.miss !== null) return { status: "miss", query: split.query, tool, report: walked.miss };
  if (walked.shape === null) return { status: "ok", query: split.query, tool, shape: null };
  let current = walked.shape;
  for (const step of binding.$reshape ?? []) {
    const flowed = reshapeShape(current, step);
    if (!flowed.ok) return { status: "miss", query: split.query, tool, report: flowed.error };
    current = flowed.shape;
  }
  return { status: "ok", query: split.query, tool, shape: current };
};

const pushMiss = (
  errors: BindingShapeError[],
  nodeId: string,
  prop: string,
  query: string,
  tool: string,
  path: string,
  report: MissReport,
): void => {
  errors.push({
    nodeId,
    prop,
    query,
    tool,
    path,
    message: report.message,
    ...(report.missing === undefined ? {} : { missing: report.missing }),
    ...(report.available === undefined ? {} : { available: report.available }),
  });
};

const collectFromValue = (
  value: unknown,
  nodeId: string,
  prop: string,
  queryTools: ReadonlyMap<string, string>,
  toolShapes: Readonly<Record<string, ShapeType>>,
  errors: BindingShapeError[],
  /** The slot contract when this value is the whole value of a slot-checked
   *  prewired prop (Select.options, Table.rows, Text.text, …); null
   *  otherwise. A nested binding inside a literal is not the slot value, so
   *  it descends with null. */
  slot: SlotCheck | null,
): void => {
  if (Array.isArray(value)) {
    // A literal option array (`options={[{value,label}]}`) is already shaped;
    // only its inner bindings are checked, never as the option list itself.
    for (const item of value) collectFromValue(item, nodeId, prop, queryTools, toolShapes, errors, null);
    return;
  }
  if (!isPlainObject(value)) return;
  if (isPathBinding(value)) {
    const check = checkBinding(value, queryTools, toolShapes);
    if (check.status === "miss") {
      pushMiss(errors, nodeId, prop, check.query, check.tool, value.$path, check.report);
      return;
    }
    if (slot !== null && check.shape !== null && check.tool !== undefined && check.query !== undefined) {
      const miss = slotMiss(slot, check.shape);
      if (miss !== null) {
        pushMiss(errors, nodeId, prop, check.query, check.tool, value.$path, miss);
      }
    }
    return; // a binding's $reshape/$path members hold no nested bindings
  }
  for (const child of Object.values(value)) {
    collectFromValue(child, nodeId, prop, queryTools, toolShapes, errors, null);
  }
};

/**
 * v2 spec §3 — check every `$path` binding in the emitted nodes against the
 * supplied tool shapes. Pure and total; returns the per-binding repair list
 * in node/prop document order.
 */
export const checkBindingShapes = (
  nodes: readonly TreeNode[],
  queries: readonly TreeQueryV2[],
  toolShapes: Readonly<Record<string, ShapeType>>,
): BindingShapeError[] => {
  const queryTools = new Map(queries.map((query) => [query.name, query.tool]));
  const errors: BindingShapeError[] = [];
  for (const node of nodes) {
    if (node.props === undefined) continue;
    for (const [prop, value] of Object.entries(node.props)) {
      collectFromValue(value, node.id, prop, queryTools, toolShapes, errors, slotFor(node, prop));
    }
  }
  return errors;
};
