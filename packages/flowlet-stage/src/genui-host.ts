/** Host-side GenUI session for the Flowlet stage.
 *
 * Holds the live data model for a resolved GenUI payload and translates a
 * streaming prop-level `ui-delta` patch into the minimal set of node
 * replacements to push into the sandbox. Pure module — no DOM/`window` — it
 * composes the already-shipped pure functions from `@flowlet/core`.
 */

import {
  applyPointerPatch,
  collectBindings,
  resolveGeneratedPayload,
  validateGeneratedPayload,
  type GeneratedPayload,
  type UINode,
} from "@flowlet/core";

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

export function createGenUISession(payload: unknown): CreateGenUISessionResult {
  const validation = validateGeneratedPayload(payload);
  if (!validation.ok) return { ok: false, error: validation.error };

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
    tree = resolveGeneratedPayload({ ...base, data });
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
            node: resolveGeneratedPayload({ ...base, root: nodeId, data }),
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
