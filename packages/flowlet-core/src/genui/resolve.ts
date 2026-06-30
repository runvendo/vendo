/** Flowlet GenUI v1 resolver — the host-side transform from a validated, FLAT,
 *  id-addressed `GeneratedPayload` graph into the NESTED `UINode` component tree
 *  the sandbox runtime renders. Pure data + types; never throws on a validated
 *  (or even mildly malformed) payload. */

import type { ComponentNode, UINode } from "../ui";
import { isPropBinding, type GeneratedPayload, type GenNode } from "./format";
import { resolvePointer } from "./pointer";

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

  const resolveNode = (id: string, ancestry: ReadonlySet<string>): ComponentNode => {
    const node = byId.get(id);
    if (node === undefined || ancestry.has(id)) return skeleton(id);

    const resolved: ComponentNode = {
      id: node.id,
      kind: "component",
      source: node.source ?? "prewired",
      name: node.component,
      props: resolveProps(node.props, data),
    };

    if (node.children !== undefined && node.children.length > 0) {
      const path = new Set(ancestry).add(id);
      resolved.children = node.children.map((childId) => resolveNode(childId, path));
    }

    return resolved;
  };

  return resolveNode(payload.root, new Set());
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
