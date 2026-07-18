/**
 * Internal: the vendo-genui/v2 wire printer — the inverse of the wave-1
 * compiler and the edit dialect's model context (v2 spec §5,
 * docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). A compile (or
 * patch) result prints back to the JSX-wire markup; with `includeIds` each
 * element is stamped with its compiler-minted id so the model can anchor a
 * patch. Only `printWireV2` is public (root export).
 *
 * The round-trip law (pinned in print.test.ts): for any COMPILER-PRODUCED
 * result, `compileWireV2(printWireV2(result))` reproduces tree, components,
 * and name byte-identically with zero issues. Hand-built trees still print
 * totally, via conservative fallbacks (explicit `<Text>` elements for unsafe
 * text, quoted `"$path"` object literals for bindings that cannot be
 * expressed as references), but only compiler output carries the guarantee.
 */

import { TOOL_NAME_PATTERN } from "../tools.js";
import { findInvalidReshapeSteps, type ReshapeStep } from "../reshape.js";
import { FN_REFERENCE_PATTERN } from "../fn-references.js";
import { isPathBinding, isPlainObject, isStateBinding, type TreeNode } from "../tree.js";
import type { TreeQueryV2 } from "../tree-v2.js";
import type { WireCompileResult } from "./compile.js";

/** v2 spec §5 — printer options. `includeIds` stamps node ids (the model's
 *  edit anchors); the bare form is the exact round-trip form. */
export interface WirePrintOptions {
  includeIds: boolean;
}

/** The printable slice of a compile/patch result. */
export type WirePrintInput = Pick<WireCompileResult, "tree" | "components" | "name">;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTION_ATTR_PATTERN = /^on[A-Z][A-Za-z0-9_]*$/;

/** Markup strings escape exactly the quote and the backslash (attributes.ts
 *  decodes only those two); expression strings use the same minimal pair —
 *  every other character round-trips verbatim through both grammars. */
const escapeString = (text: string): string => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const printNumber = (value: number): string => (Object.is(value, -0) ? "-0" : JSON.stringify(value));

/** A binding prints as a bare dotted reference only when the compiler could
 *  have produced it: identifier segments, a declared query name up front,
 *  no pointer escapes, and nothing beyond `$path`/`$state` + a valid
 *  `$reshape` on the object. */
const referenceForBinding = (value: Record<string, unknown>, queryNames: ReadonlySet<string>): string | null => {
  const keys = Object.keys(value).filter((key) => key !== "$reshape");
  if (keys.length !== 1) return null;
  const steps = value.$reshape as ReshapeStep[] | undefined;
  if (steps !== undefined && findInvalidReshapeSteps(steps) !== null) return null;
  let base: string | null = null;
  if (isStateBinding(value)) {
    base = IDENTIFIER_PATTERN.test(value.$state) ? `state.${value.$state}` : null;
  } else if (isPathBinding(value)) {
    const path = value.$path;
    if (!path.startsWith("/") || path.includes("~")) return null;
    const segments = path.slice(1).split("/");
    if (!segments.every((segment) => IDENTIFIER_PATTERN.test(segment))) return null;
    if (!queryNames.has(segments[0] as string) || segments[0] === "state") return null;
    base = segments.join(".");
  }
  if (base === null) return null;
  const pipes = (steps ?? []).map((step) =>
    ` | ${step.op}(${step.args.map((arg) => (IDENTIFIER_PATTERN.test(arg) ? arg : `"${escapeString(arg)}"`)).join(", ")})`);
  return base + pipes.join("");
};

const printExpression = (value: unknown, queryNames: ReadonlySet<string>): string => {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return printNumber(value);
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (Array.isArray(value)) {
    return `[${value.map((item) => printExpression(item, queryNames)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const reference = isPathBinding(record) || isStateBinding(record)
      ? referenceForBinding(record, queryNames)
      : null;
    if (reference !== null) return reference;
    const entries = Object.entries(record).map(([key, child]) => {
      const printedKey = IDENTIFIER_PATTERN.test(key) ? key : `"${escapeString(key)}"`;
      return `${printedKey}: ${printExpression(child, queryNames)}`;
    });
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  // Non-Json (undefined, functions) cannot come out of the compiler; print
  // null so the output stays parseable (totality over fidelity here).
  return "null";
};

/** True when `{ action: "..." }` may print back as the string action form on
 *  this attribute (D5's inverse). */
const isStringFormAction = (name: string, value: unknown): value is { action: string } =>
  ACTION_ATTR_PATTERN.test(name)
  && isPlainObject(value)
  && Object.keys(value).length === 1
  && typeof (value as { action?: unknown }).action === "string"
  && (TOOL_NAME_PATTERN.test((value as { action: string }).action)
    || FN_REFERENCE_PATTERN.test((value as { action: string }).action));

const printAttribute = (name: string, value: unknown, queryNames: ReadonlySet<string>): string => {
  if (value === true) return name;
  if (typeof value === "string") return `${name}="${escapeString(value)}"`;
  if (isStringFormAction(name, value)) return `${name}="${(value as { action: string }).action}"`;
  return `${name}={${printExpression(value, queryNames)}}`;
};

/** A Text node prints as a bare text child only when the wave-1 text rule
 *  would mint it back identically: prewired, `{ text }` alone, childless,
 *  already trimmed, non-empty, and free of `<`. */
const printableAsBareText = (node: TreeNode): string | null => {
  if (node.component !== "Text" || node.source !== "prewired") return null;
  if (node.children !== undefined && node.children.length > 0) return null;
  const props = node.props ?? {};
  const keys = Object.keys(props);
  if (keys.length !== 1 || keys[0] !== "text") return null;
  const text = props.text;
  if (typeof text !== "string" || text.length === 0) return null;
  if (text !== text.trim() || text.includes("<")) return null;
  return text;
};

interface PrintState {
  lines: string[];
  nodes: ReadonlyMap<string, TreeNode>;
  queryNames: ReadonlySet<string>;
  includeIds: boolean;
  /** Cycle guard for hand-built trees (compiler output is acyclic). */
  printing: Set<string>;
}

const printNode = (state: PrintState, nodeId: string, depth: number): void => {
  const node = state.nodes.get(nodeId);
  if (node === undefined || state.printing.has(nodeId)) return;
  const indent = "  ".repeat(depth);
  const bareText = printableAsBareText(node);
  if (bareText !== null) {
    state.lines.push(indent + bareText);
    return;
  }
  const attrs: string[] = [];
  if (state.includeIds) attrs.push(`id="${escapeString(node.id)}"`);
  for (const [name, value] of Object.entries(node.props ?? {})) {
    attrs.push(printAttribute(name, value, state.queryNames));
  }
  const open = `<${node.component}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}`;
  const children = node.children ?? [];
  if (children.length === 0) {
    state.lines.push(`${indent}${open}/>`);
    return;
  }
  state.lines.push(`${indent}${open}>`);
  state.printing.add(nodeId);
  for (const childId of children) printNode(state, childId, depth + 1);
  state.printing.delete(nodeId);
  state.lines.push(`${indent}</${node.component}>`);
};

const printQuery = (query: TreeQueryV2, queryNames: ReadonlySet<string>): string => {
  const attrs = [`id="${escapeString(query.name)}"`, `tool="${escapeString(query.tool)}"`];
  if (query.input !== undefined) attrs.push(`input={${printExpression(query.input, queryNames)}}`);
  return `  <Query ${attrs.join(" ")}/>`;
};

/**
 * v2 spec §5 — print a compile/patch result back to wire markup. Pure,
 * deterministic, total. Document order matches the spec example (queries →
 * body → islands), which also keeps re-minted ids identical on recompile.
 */
export function printWireV2(input: WirePrintInput, options: WirePrintOptions): string {
  const { tree, components } = input;
  const queryNames = new Set((tree.queries ?? []).map((query) => query.name));
  const state: PrintState = {
    lines: [],
    nodes: new Map(tree.nodes.map((node) => [node.id, node])),
    queryNames,
    includeIds: options.includeIds,
    printing: new Set(),
  };
  const appAttrs = input.name === undefined ? "" : ` name="${escapeString(input.name)}"`;
  const root = state.nodes.get(tree.root);
  const rootChildren = root?.children ?? [];
  const hasBody = rootChildren.length > 0
    || (tree.queries ?? []).length > 0
    || Object.keys(components).length > 0;
  if (!hasBody) return `<App${appAttrs}/>`;
  state.lines.push(`<App${appAttrs}>`);
  for (const query of tree.queries ?? []) state.lines.push(printQuery(query, queryNames));
  for (const childId of rootChildren) printNode(state, childId, 1);
  for (const [name, source] of Object.entries(components)) {
    state.lines.push(`  <Island name="${escapeString(name)}">${source}</Island>`);
  }
  state.lines.push("</App>");
  return state.lines.join("\n");
}
