/** Flowlet GenUI v1 resolver — the host-side transform from a validated, FLAT,
 *  id-addressed `GeneratedPayload` graph into the NESTED `UINode` component tree
 *  the sandbox runtime renders. Pure data + types; depth-bounded so it never
 *  throws (even on an adversarial deep chain it stops recursing at MAX_DEPTH and
 *  emits a contained Skeleton placeholder instead of overflowing the stack). */

import type { ComponentNode, UINode } from "../ui";
import { isPropBinding, type GeneratedPayload, type GenNode } from "./format";
import { resolvePointer } from "./pointer";

/** Maximum nesting depth resolved before a Skeleton placeholder caps the branch.
 *  Bounds recursion regardless of node count, preventing a stack overflow. */
const MAX_DEPTH = 256;

/** A streaming/forward-reference placeholder for an unresolved or cyclic node. */
const skeleton = (id: string): ComponentNode => ({
  id,
  kind: "component",
  source: "prewired",
  name: "Skeleton",
  props: {},
});

/** Resolve a node's props, replacing `$path` bindings with their data value and
 *  passing every other value (literals, non-`$path` objects like `$state`) through. */
function resolveProps(
  props: Record<string, unknown> | undefined,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (props === undefined) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    resolved[key] = isPropBinding(value) ? resolvePointer(data, value.$path) : value;
  }
  return resolved;
}

/** Walk a validated GenUI payload from its root into a nested ComponentNode tree. */
export function resolveGeneratedPayload(payload: GeneratedPayload): UINode {
  const byId = new Map<string, GenNode>(payload.nodes.map((n) => [n.id, n]));
  const data = payload.data ?? {};

  const resolveNode = (id: string, ancestry: ReadonlySet<string>, depth: number): ComponentNode => {
    const node = byId.get(id);
    // Beyond MAX_DEPTH, stop recursing and cap the branch with a placeholder so
    // an adversarial deep chain can never overflow the stack.
    if (node === undefined || ancestry.has(id) || depth > MAX_DEPTH) return skeleton(id);

    const resolved: ComponentNode = {
      id: node.id,
      kind: "component",
      source: node.source ?? "prewired",
      name: node.component,
      props: resolveProps(node.props, data),
    };

    if (node.children !== undefined && node.children.length > 0) {
      const path = new Set(ancestry).add(id);
      resolved.children = node.children.map((childId) => resolveNode(childId, path, depth + 1));
    }

    return resolved;
  };

  return resolveNode(payload.root, new Set(), 0);
}

/** Collect the JSON Pointers referenced by this node's top-level `$path` props,
 *  in prop-iteration order (no dedup). Used to know which nodes a data patch hits. */
export function collectBindings(node: GenNode): string[] {
  if (node.props === undefined) return [];
  const paths: string[] = [];
  for (const value of Object.values(node.props)) {
    if (isPropBinding(value)) paths.push(value.$path);
  }
  return paths;
}
