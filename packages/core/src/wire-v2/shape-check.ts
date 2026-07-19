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

const checkBinding = (
  binding: { $path: string; $reshape?: ReshapeStep[] },
  queryTools: ReadonlyMap<string, string>,
  toolShapes: Readonly<Record<string, ShapeType>>,
): { query: string; tool: string; report: MissReport } | null => {
  const split = splitPath(binding.$path);
  if (split === null) return null;
  const tool = queryTools.get(split.query);
  if (tool === undefined) return null; // undeclared/dropped query — wave-1 layers own that
  const toolShape = Object.prototype.hasOwnProperty.call(toolShapes, tool)
    ? (toolShapes as Record<string, ShapeType | undefined>)[tool]
    : undefined;
  if (toolShape === undefined) return null; // no shape card — Json, defensive
  const walked = walkPointer(toolShape, split.pointer);
  if (walked.miss !== null) return { query: split.query, tool, report: walked.miss };
  if (walked.shape === null) return null;
  let current = walked.shape;
  for (const step of binding.$reshape ?? []) {
    const flowed = reshapeShape(current, step);
    if (!flowed.ok) return { query: split.query, tool, report: flowed.error };
    current = flowed.shape;
  }
  return null;
};

const collectFromValue = (
  value: unknown,
  nodeId: string,
  prop: string,
  queryTools: ReadonlyMap<string, string>,
  toolShapes: Readonly<Record<string, ShapeType>>,
  errors: BindingShapeError[],
): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, nodeId, prop, queryTools, toolShapes, errors);
    return;
  }
  if (!isPlainObject(value)) return;
  if (isPathBinding(value)) {
    const violation = checkBinding(value, queryTools, toolShapes);
    if (violation !== null) {
      errors.push({
        nodeId,
        prop,
        query: violation.query,
        tool: violation.tool,
        path: value.$path,
        message: violation.report.message,
        ...(violation.report.missing === undefined ? {} : { missing: violation.report.missing }),
        ...(violation.report.available === undefined ? {} : { available: violation.report.available }),
      });
    }
    return; // a binding's $reshape/$path members hold no nested bindings
  }
  for (const child of Object.values(value)) {
    collectFromValue(child, nodeId, prop, queryTools, toolShapes, errors);
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
      collectFromValue(value, node.id, prop, queryTools, toolShapes, errors);
    }
  }
  return errors;
};
