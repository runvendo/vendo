/** Flowlet GenUI v1 — a declarative, A2UI-subset format an LLM emits as the
 *  payload of a `generated` UINode. Pure data + types; decoupled from any LLM. */

export const FLOWLET_GENUI_VERSION = "flowlet-genui/v1" as const;

/** A prop value that binds to the data model via a JSON Pointer. */
export interface PropBinding {
  $path: string;
}

/** A prop is either a literal or a PropBinding (distinguished structurally at resolve time). */
export type PropValue = unknown;

/** True iff `v` is a non-null object whose `$path` is a string. */
export function isPropBinding(v: unknown): v is PropBinding {
  return typeof v === "object" && v !== null && typeof (v as { $path?: unknown }).$path === "string";
}

export interface GenNode {
  id: string;
  component: string;
  source?: "prewired" | "host";
  props?: Record<string, PropValue>;
  children?: string[];
}

export interface GeneratedPayload {
  formatVersion: string;
  root: string;
  nodes: GenNode[];
  data?: Record<string, unknown>;
}

/** Error codes are kept as a local literal union to avoid coupling core to stage. */
export type GenUIErrorCode = "version" | "provision";

export type GenUIValidation =
  | { ok: true; payload: GeneratedPayload }
  | { ok: false; error: { code: GenUIErrorCode; message: string } };

const fail = (code: GenUIErrorCode, message: string): GenUIValidation => ({
  ok: false,
  error: { code, message },
});

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure, never-throwing validator for a Flowlet GenUI v1 payload. */
export function validateGeneratedPayload(input: unknown): GenUIValidation {
  if (!isPlainObject(input)) {
    return fail("provision", "payload must be a non-null object");
  }

  if (input.formatVersion !== FLOWLET_GENUI_VERSION) {
    return fail("version", `formatVersion must be "${FLOWLET_GENUI_VERSION}"`);
  }

  const { root, nodes } = input;
  if (typeof root !== "string" || root.length === 0) {
    return fail("provision", "root must be a non-empty string");
  }
  if (!Array.isArray(nodes)) {
    return fail("provision", "nodes must be an array");
  }

  const ids = new Set<string>();
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      return fail("provision", "each node must be an object");
    }
    if (typeof node.id !== "string") {
      return fail("provision", "each node must have a string id");
    }
    if (typeof node.component !== "string") {
      return fail("provision", `node "${node.id}" must have a string component`);
    }
    if (node.source !== undefined && node.source !== "prewired" && node.source !== "host") {
      return fail("provision", `node "${node.id}" has an invalid source`);
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children) || !node.children.every((c) => typeof c === "string")) {
        return fail("provision", `node "${node.id}" children must be an array of strings`);
      }
    }
    if (node.props !== undefined && !isPlainObject(node.props)) {
      return fail("provision", `node "${node.id}" props must be a plain object`);
    }
    if (ids.has(node.id)) {
      return fail("provision", `duplicate node id "${node.id}"`);
    }
    ids.add(node.id);
  }

  if (!ids.has(root)) {
    return fail("provision", `root "${root}" does not match any node id`);
  }

  // Dangling child ids are intentionally allowed: a child with no matching node
  // is a legitimate forward reference (renders as a streaming Skeleton downstream).

  return { ok: true, payload: input as unknown as GeneratedPayload };
}
