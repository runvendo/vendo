/** Host-side GenUI session for the Vendo stage.
 *
 * Holds the live data model for a resolved GenUI payload and translates a
 * streaming prop-level `ui-delta` patch into the minimal set of node
 * replacements to push into the sandbox. Pure module — no DOM/`window` — it
 * composes the already-shipped pure functions from `@vendoai/core`.
 */

import {
  applyPointerPatch,
  collectBindings,
  resolveGeneratedPayload,
  validateGeneratedPayload,
  type GeneratedPayload,
  type RegisteredComponent,
  type UINode,
} from "@vendoai/core";

export interface GenUISession {
  /** Initial resolved tree (for `StageInitPayload.tree`). */
  tree: UINode;
  /** Apply a JSON-Pointer data patch; returns the node replacements it triggers. */
  applyDataPatch(path: string, value?: unknown): Array<{ nodeId: string; node: UINode }>;
  /** Current data model (for tests/inspection). */
  getData(): Readonly<Record<string, unknown>>;
}

export type CreateGenUISessionResult =
  | { ok: true; session: GenUISession }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

/** True when `pointer` and `path` overlap at a JSON-Pointer segment boundary —
 *  equal, or one is an ancestor of the other. Avoids `/user` matching `/username`. */
function pointersOverlap(pointer: string, path: string): boolean {
  return (
    pointer === path ||
    pointer.startsWith(path + "/") ||
    path.startsWith(pointer + "/")
  );
}

/** A contained placeholder for a host node whose props failed registry validation. */
const invalidPropsNode = (id: string, name: string): UINode => ({
  id,
  kind: "component",
  source: "prewired",
  name: "Text",
  props: { text: `[invalid props: ${name}]` },
});

/**
 * Walk a resolved `UINode` tree and, for each `source === "host"` node whose
 * name is in the registry, validate its already-bound props against the
 * descriptor's `propsSchema` via Standard Schema. A node that fails is REPLACED
 * by a contained error placeholder (siblings unaffected). Nodes not in the
 * registry are left as-is (unknown names are handled at runtime). Only SYNCHRONOUS
 * schemas are validated in v1: if `validate` returns a Promise the node is left
 * unchanged. Returns the original node reference when nothing changed.
 */
function validateHostProps(
  node: UINode,
  registry: ReadonlyMap<string, RegisteredComponent>,
): UINode {
  if (node.kind !== "component") return node;

  const children = node.children;
  let nextChildren = children;
  if (children !== undefined) {
    let changed = false;
    const mapped = children.map((child) => {
      const v = validateHostProps(child, registry);
      if (v !== child) changed = true;
      return v;
    });
    if (changed) nextChildren = mapped;
  }

  if (node.source === "host") {
    const descriptor = registry.get(node.name);
    if (descriptor !== undefined) {
      const result = descriptor.propsSchema["~standard"].validate(node.props);
      // Async schemas are not validated in v1 — a Promise means skip this node.
      if (!(result instanceof Promise) && result.issues) {
        return invalidPropsNode(node.id, node.name);
      }
    }
  }

  return nextChildren === children ? node : { ...node, children: nextChildren };
}

export interface CreateGenUISessionOptions {
  /** F1 component registry; host-node props are validated against descriptors. */
  registry?: RegisteredComponent[];
}

export function createGenUISession(
  payload: unknown,
  opts?: CreateGenUISessionOptions,
): CreateGenUISessionResult {
  const validation = validateGeneratedPayload(payload);
  if (!validation.ok) return { ok: false, error: validation.error };

  const registry = new Map<string, RegisteredComponent>(
    (opts?.registry ?? []).map((c) => [c.name, c]),
  );

  const base: GeneratedPayload = validation.payload;
  let data: Record<string, unknown> = base.data ?? {};

  // Pointer → node ids that bind it. Built once: structure never changes on a
  // data patch, only `data` does, so the binding index stays valid.
  const pointerIndex = new Map<string, string[]>();
  for (const node of base.nodes) {
    for (const pointer of collectBindings(node)) {
      const ids = pointerIndex.get(pointer);
      if (ids === undefined) pointerIndex.set(pointer, [node.id]);
      else ids.push(node.id);
    }
  }
  // Original node order, for deterministic output ordering.
  const order = new Map(base.nodes.map((n, i) => [n.id, i]));

  // Defense-in-depth: the resolver is depth-bounded, but never let a throw on
  // untrusted input escape session creation — surface it as a provision error.
  let tree: UINode;
  try {
    tree = validateHostProps(resolveGeneratedPayload({ ...base, data }), registry);
  } catch (err) {
    return {
      ok: false,
      error: { code: "provision", message: err instanceof Error ? err.message : String(err) },
    };
  }

  const session: GenUISession = {
    tree,

    applyDataPatch(path: string, value?: unknown) {
      // Preserve the delete-vs-set distinction the core pointer patch relies on:
      // omit `value` to delete, forward it (even `undefined`) to set.
      data =
        arguments.length < 2
          ? applyPointerPatch(data, path)
          : applyPointerPatch(data, path, value);

      const affected = new Set<string>();
      for (const [pointer, ids] of pointerIndex) {
        if (pointersOverlap(pointer, path)) {
          for (const id of ids) affected.add(id);
        }
      }

      try {
        return [...affected]
          .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
          .map((nodeId) => ({
            nodeId,
            node: validateHostProps(
              resolveGeneratedPayload({ ...base, root: nodeId, data }),
              registry,
            ),
          }));
      } catch {
        // Defense-in-depth: never let a resolve throw escape a data patch.
        return [];
      }
    },

    getData() {
      return data;
    },
  };

  return { ok: true, session };
}
