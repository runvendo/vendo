import type { Json, JsonSchema } from "./ids.js";
import { defineOwn } from "./genui/tree-node.js";

/**
 * v2 spec §3 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * the shape model behind shape-aware binding. A ShapeType is the structural
 * type of a host tool / fn: response: field names, kinds, and (where the host
 * declared one) the closed enum. `json` is the unknown type — the defensive
 * default the spec assigns wherever no shape is known.
 *
 * Shapes come from the host's DECLARED schemas ({@link shapeFromJsonSchema});
 * the engine hands them to the model as generation context
 * ({@link describeShape}) and to the wire compiler as `toolShapes` for the
 * binding type-check (genui/wire/shape-check.ts). Nothing samples the host.
 */
export type ShapeType =
  | { kind: "string" | "number" | "boolean" | "null" | "json"; enum?: readonly Json[] }
  | { kind: "array"; items: ShapeType }
  | { kind: "object"; fields: Record<string, ShapeType>; optional?: string[] };

const JSON_SHAPE: ShapeType = { kind: "json" };

/** Depth bound for schema→shape conversion: beyond it a region degrades to
 *  `json` (defensive) instead of risking the call stack on a pathologically
 *  nested schema. Deeper than any real tool response. */
const SHAPE_MAX_DEPTH = 32;

const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

/** One pointer-walk miss, with the field context per-binding repair needs
 *  (genui/wire/shape-check.ts). */
export interface ShapePointerMiss {
  message: string;
  missing?: string[];
  available?: string[];
}

/**
 * v2 spec §3 — walk a shape by RFC 6901 JSON Pointer (`""` is the whole
 * shape), reporting the first miss with the field context repair needs.
 * `json` stays `json` at any depth (the unknown type is closed under
 * projection). `null` shape + `null` miss means an undecodable pointer
 * segment — treated as unknown, not an error (validate layers own pointer
 * grammar). The pointer must be `""` or start with `/`.
 */
export const walkShapePointer = (
  shape: ShapeType,
  pointer: string,
): { shape: ShapeType | null; miss: ShapePointerMiss | null } => {
  let current = shape;
  if (pointer === "") return { shape: current, miss: null };
  for (const encodedToken of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encodedToken)) return { shape: null, miss: null };
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current.kind === "json") return { shape: JSON_SHAPE, miss: null };
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
      if (!ARRAY_INDEX_PATTERN.test(token)) {
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

/**
 * v2 spec §3 — the miss-blind view of {@link walkShapePointer}: absent
 * fields, non-index segments into arrays, and segments past scalars return
 * `undefined` — the compile-time miss the shape check reports.
 */
export function shapeAtPointer(shape: ShapeType, pointer: string): ShapeType | undefined {
  if (pointer !== "" && !pointer.startsWith("/")) return undefined;
  return walkShapePointer(shape, pointer).shape ?? undefined;
}

/** Default {@link describeShape} depth: enough for any real tool response
 *  card while keeping prompt context bounded. */
const DESCRIBE_MAX_DEPTH = 6;

/** A declared enum prints its VALUES: the closed vocabulary is the useful fact,
 *  and a model that reads `string` where the host declared `"paid" | "void"`
 *  invents values the host will reject. */
export const enumText = (values: readonly Json[] | undefined): string | undefined =>
  values === undefined || values.length === 0
    ? undefined
    : values.map((value) => JSON.stringify(value)).join(" | ");

const describeShapeAt = (shape: ShapeType, depth: number): string => {
  if (depth <= 0) return "…";
  if (shape.kind === "json") return "Json";
  if (shape.kind === "array") return `${describeShapeAt(shape.items, depth - 1)}[]`;
  if (shape.kind === "object") {
    const optional = new Set(shape.optional ?? []);
    const entries = Object.entries(shape.fields).map(([key, field]) =>
      `${key}${optional.has(key) ? "?" : ""}: ${describeShapeAt(field, depth - 1)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return enumText(shape.enum) ?? shape.kind;
};

/** v2 spec §3 — the compact notation the engine embeds in the model's tool
 *  context (e.g. `{ month: string, revenue: number }[]`). Deterministic,
 *  depth-bounded (`…` beyond {@link DESCRIBE_MAX_DEPTH}). */
export function describeShape(shape: ShapeType): string {
  return describeShapeAt(shape, DESCRIBE_MAX_DEPTH);
}

const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SCALAR_KINDS: Readonly<Record<string, "string" | "number" | "boolean" | "null">> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  null: "null",
};

const shapeFromJsonSchemaAt = (schema: unknown, depth: number): ShapeType => {
  if (depth >= SHAPE_MAX_DEPTH || !isSchemaObject(schema)) return JSON_SHAPE;
  const values = Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : undefined;
  const declared = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const kind = typeof declared === "string" ? SCALAR_KINDS[declared] : undefined;
  if (kind !== undefined) return values === undefined ? { kind } : { kind, enum: values };
  if (declared === "array") return { kind: "array", items: shapeFromJsonSchemaAt(schema.items, depth + 1) };
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // Sibling `properties` are one more member of the intersection; the emptied
    // `allOf` stops the branch re-entering itself.
    const own = isSchemaObject(schema.properties) ? [{ ...schema, allOf: [] }] : [];
    return intersectSchemas([...schema.allOf, ...own], depth);
  }
  if (declared === "object" || isSchemaObject(schema.properties)) {
    const properties = isSchemaObject(schema.properties) ? schema.properties : {};
    const required = new Set((Array.isArray(schema.required) ? schema.required : [])
      .filter((name): name is string => typeof name === "string"));
    const fields: Record<string, ShapeType> = {};
    const optional: string[] = [];
    for (const [name, property] of Object.entries(properties)) {
      defineOwn(fields, name, shapeFromJsonSchemaAt(property, depth + 1));
      if (!required.has(name)) optional.push(name);
    }
    return optional.length > 0 ? { kind: "object", fields, optional } : { kind: "object", fields };
  }
  // A bare enum/const with no `type`: the values themselves name the kind.
  if (values !== undefined) {
    const valueKind = SCALAR_KINDS[typeof values[0]];
    if (valueKind !== undefined) return { kind: valueKind, enum: values };
  }
  return JSON_SHAPE;
};

/** The keywords by which a branch DESCRIBES a value rather than merely
 *  constraining one. A branch carrying none of them — `{ required: [...] }`,
 *  `{ additionalProperties: false }`, a bare `description` — is the standard
 *  OpenAPI idiom for tightening a sibling, and it must not erase the branches
 *  that do the describing. */
const VALUE_KEYWORDS = ["type", "properties", "items", "enum", "const", "allOf", "anyOf", "oneOf", "not", "$ref"] as const;

/** `allOf` is an INTERSECTION: the value carries EVERY branch's fields at once,
 *  and a field is required as soon as one branch requires it. Erasing it to
 *  `json` erases the whole declaration — demo-bank's own transfer result is an
 *  `allOf`, enums included — from the binding check and the screen type check.
 *  A branch that describes a NON-object (a scalar, an array) or that nothing
 *  could model (`anyOf`, `$ref`) still degrades the intersection whole: better
 *  unconstrained than confidently narrow. */
const intersectSchemas = (branches: readonly unknown[], depth: number): ShapeType => {
  const fields: Record<string, ShapeType> = {};
  const required = new Set<string>();
  let described = false;
  for (const branch of branches) {
    if (!isSchemaObject(branch)) return JSON_SHAPE;
    // Folded in for EVERY branch, so a constraint-only member still gets to
    // make a sibling's optional field required.
    for (const name of Array.isArray(branch.required) ? branch.required : []) {
      if (typeof name === "string") required.add(name);
    }
    const shape = shapeFromJsonSchemaAt(branch, depth + 1);
    if (shape.kind !== "object") {
      if (VALUE_KEYWORDS.some((keyword) => keyword in branch)) return JSON_SHAPE;
      continue;
    }
    described = true;
    const branchOptional = new Set(shape.optional ?? []);
    for (const [name, field] of Object.entries(shape.fields)) {
      defineOwn(fields, name, field);
      if (!branchOptional.has(name)) required.add(name);
    }
  }
  // Constraints alone describe no fields; closing an empty object here would
  // refuse every binding through it.
  if (!described) return JSON_SHAPE;
  const optional = Object.keys(fields).filter((name) => !required.has(name));
  return optional.length > 0 ? { kind: "object", fields, optional } : { kind: "object", fields };
};

/**
 * A DECLARED JSON Schema in the checks' structural form — the producer of
 * `toolShapes` now that nothing samples. `allOf` intersects; other unmodelled
 * constructs (anyOf, $ref, custom keywords) degrade to `{ kind: "json" }`,
 * never a throw.
 * `enum`/`const` SURVIVE onto the scalar branch: an enum erased to a bare
 * `string` is what refused a correct screen at the checks floor (live 2026-08,
 * demo-bank's spending donut).
 */
export function shapeFromJsonSchema(schema: JsonSchema): ShapeType {
  return shapeFromJsonSchemaAt(schema, 0);
}
