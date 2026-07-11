/** Vendo GenUI v1 — a declarative, A2UI-subset format an LLM emits as the
 *  payload of a `generated` UINode. Pure data + types; decoupled from any LLM. */

export const VENDO_GENUI_VERSION = "vendo-genui/v1" as const;

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

/** Declared provenance of a `data` subtree: the tool call that produced it.
 *  Reopening a saved view re-runs these through the normal (policy-governed)
 *  tool path and patches results back in at `path` (ENG-183). */
export interface DataQuery {
  /** RFC 6901 JSON Pointer into `data`; "" replaces the whole model. */
  path: string;
  tool: string;
  input?: Record<string, unknown>;
}

export interface GenNode {
  id: string;
  component: string;
  source?: "prewired" | "host" | "generated";
  props?: Record<string, PropValue>;
  children?: string[];
}

export interface GeneratedPayload {
  formatVersion: string;
  root: string;
  nodes: GenNode[];
  data?: Record<string, unknown>;
  /** Optional declared provenance of `data`. */
  queries?: DataQuery[];
  /** Tier 2.5: name → ESM React component source, evaluated in-sandbox. */
  components?: Record<string, string>;
}

/** Hard cap on node count. A payload over this many nodes is rejected as a
 *  provision error — defends against untrusted deep/large graphs (DoS). */
export const MAX_GENUI_NODES = 5000;

/** Names of the prewired primitives shipped inside the stage runtime. The
 *  format reserves them: a generated component may not shadow a primitive. */
export const RESERVED_COMPONENT_NAMES = ["Stack", "Row", "Grid", "Text", "Skeleton", "Surface", "Divider"] as const;

/** Cap on declared data queries (DoS defense, consistent with MAX_GENUI_NODES). */
export const MAX_GENUI_QUERIES = 16;

/** Caps for generated component code (DoS defense, consistent with MAX_GENUI_NODES). */
export const MAX_GENERATED_COMPONENTS = 16;
export const MAX_COMPONENT_SOURCE_CHARS = 65_536; // 64 KB per component
export const MAX_TOTAL_COMPONENT_CHARS = 262_144; // 256 KB per payload

/** Generated component names: PascalCase identifiers. */
const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;

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

/** Pure, never-throwing validator for a Vendo GenUI v1 payload. */
export function validateGeneratedPayload(input: unknown): GenUIValidation {
  if (!isPlainObject(input)) {
    return fail("provision", "payload must be a non-null object");
  }

  if (input.formatVersion !== VENDO_GENUI_VERSION) {
    return fail("version", `formatVersion must be "${VENDO_GENUI_VERSION}"`);
  }

  const { root, nodes } = input;
  if (typeof root !== "string" || root.length === 0) {
    return fail("provision", "root must be a non-empty string");
  }
  if (!Array.isArray(nodes)) {
    return fail("provision", "nodes must be an array");
  }
  if (nodes.length > MAX_GENUI_NODES) {
    return fail("provision", `too many nodes (max ${MAX_GENUI_NODES})`);
  }
  if (input.data !== undefined && !isPlainObject(input.data)) {
    return fail("provision", "data must be a plain object");
  }
  if (input.queries !== undefined) {
    if (!Array.isArray(input.queries)) return fail("provision", "queries must be an array");
    if (input.queries.length > MAX_GENUI_QUERIES) {
      return fail("provision", `too many queries (max ${MAX_GENUI_QUERIES})`);
    }
    for (const q of input.queries) {
      if (!isPlainObject(q)) return fail("provision", "each query must be an object");
      if (typeof q.path !== "string" || (q.path !== "" && q.path[0] !== "/")) {
        return fail("provision", "query path must be a JSON Pointer ('' or starting with '/')");
      }
      if (typeof q.tool !== "string" || q.tool.length === 0) {
        return fail("provision", "query tool must be a non-empty string");
      }
      if (q.input !== undefined && !isPlainObject(q.input)) {
        return fail("provision", "query input must be a plain object");
      }
    }
  }

  const ids = new Set<string>();
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      return fail("provision", "each node must be an object");
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      return fail("provision", "each node must have a non-empty string id");
    }
    if (typeof node.component !== "string") {
      return fail("provision", `node "${node.id}" must have a string component`);
    }
    if (
      node.source !== undefined &&
      node.source !== "prewired" &&
      node.source !== "host" &&
      node.source !== "generated"
    ) {
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

  // ── Tier 2.5: generated component code map ─────────────────────────────────
  const components = input.components;
  if (components !== undefined && !isPlainObject(components)) {
    return fail("provision", "components must be a plain object");
  }
  const componentMap = (components ?? {}) as Record<string, unknown>;
  const names = Object.keys(componentMap);
  if (names.length > MAX_GENERATED_COMPONENTS) {
    return fail("provision", `too many generated components (max ${MAX_GENERATED_COMPONENTS})`);
  }
  let totalChars = 0;
  for (const name of names) {
    if (!COMPONENT_NAME_RE.test(name)) {
      return fail("provision", `generated component name "${name}" must be a PascalCase identifier`);
    }
    if ((RESERVED_COMPONENT_NAMES as readonly string[]).includes(name)) {
      return fail("provision", `generated component name "${name}" is reserved (prewired primitive)`);
    }
    const src = componentMap[name];
    if (typeof src !== "string") {
      return fail("provision", `generated component "${name}" source must be a string`);
    }
    if (src.length > MAX_COMPONENT_SOURCE_CHARS) {
      return fail("provision", `generated component "${name}" source too large (max ${MAX_COMPONENT_SOURCE_CHARS} chars)`);
    }
    totalChars += src.length;
  }
  if (totalChars > MAX_TOTAL_COMPONENT_CHARS) {
    return fail("provision", `generated component sources too large in total (max ${MAX_TOTAL_COMPONENT_CHARS} chars)`);
  }
  // A generated-source node must have a definition. Deliberately stricter than
  // dangling child ids (which resolve to Skeleton as a streaming affordance):
  // a missing child may still arrive; a missing definition never will.
  // (Every node was shape-validated by the loop above, so the cast is safe.)
  for (const node of nodes as GenNode[]) {
    if (node.source === "generated" && !Object.prototype.hasOwnProperty.call(componentMap, node.component)) {
      return fail("provision", `node "${node.id}" references generated component "${node.component}" with no definition in components`);
    }
  }

  if (!ids.has(root)) {
    return fail("provision", `root "${root}" does not match any node id`);
  }

  // Dangling child ids are intentionally allowed: a child with no matching node
  // is a legitimate forward reference (renders as a streaming Skeleton downstream).

  return { ok: true, payload: input as unknown as GeneratedPayload };
}
