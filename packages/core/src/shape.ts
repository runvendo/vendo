import { z } from "zod";
import type { IsoDateTime, Json, JsonSchema } from "./ids.js";
import { defineOwn } from "./genui/tree-node.js";

/**
 * v2 spec §3 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * the shape model behind shape-aware binding. A ShapeType is the structural
 * type of a host tool / fn: response with every value hashed away: field
 * names, kinds, and nesting only. `json` is the unknown type — the defensive
 * default the spec assigns wherever no shape is known.
 *
 * Shape cards are derived from recorded samples ({@link deriveShapeCard});
 * the engine hands them to the model as generation context
 * ({@link describeShape}) and to the wire compiler as `toolShapes` for the
 * binding type-check (genui/wire/shape-check.ts).
 */
export type ShapeType =
  | { kind: "string" | "number" | "boolean" | "null" | "json"; enum?: readonly Json[] }
  | { kind: "array"; items: ShapeType }
  | { kind: "object"; fields: Record<string, ShapeType>; optional?: string[] };

/** v2 spec §3 — structural shape only (the types+zod pairing convention). */
const shapeTypeSchema: z.ZodType<ShapeType> = z.lazy(() => z.union([
  z.object({ kind: z.enum(["string", "number", "boolean", "null", "json"]), enum: z.array(z.unknown()).optional() }),
  z.object({ kind: z.literal("array"), items: shapeTypeSchema }),
  z.object({
    kind: z.literal("object"),
    fields: z.record(shapeTypeSchema),
    optional: z.array(z.string()).optional(),
  }),
]));

/** v2 spec §3 — one tool's response shape: derived from recorded samples
 *  (`source: "sample"`) or declared by the host (`source: "declared"`). */
export interface ShapeCard {
  tool: string;
  output: ShapeType;
  source: "sample" | "declared";
  sampledAt?: IsoDateTime;
}

/** v2 spec §3 — structural shape only (the types+zod pairing convention). */
export const shapeCardSchema = z.object({
  tool: z.string().min(1),
  output: shapeTypeSchema,
  source: z.enum(["sample", "declared"]),
  sampledAt: z.string().optional(),
}).passthrough() satisfies z.ZodType<ShapeCard>;

const JSON_SHAPE: ShapeType = { kind: "json" };

/** Depth bound shared by derivation and merging: beyond it a region degrades
 *  to `json` (defensive) instead of risking the call stack on pathological
 *  samples. Deeper than any real tool response. */
const SHAPE_MAX_DEPTH = 32;

const deriveShapeAt = (sample: unknown, depth: number): ShapeType => {
  if (depth >= SHAPE_MAX_DEPTH) return JSON_SHAPE;
  if (sample === null) return { kind: "null" };
  if (typeof sample === "string") return { kind: "string" };
  if (typeof sample === "number") return { kind: "number" };
  if (typeof sample === "boolean") return { kind: "boolean" };
  if (Array.isArray(sample)) {
    let items: ShapeType | undefined;
    for (const element of sample) {
      const elementShape = deriveShapeAt(element, depth + 1);
      items = items === undefined ? elementShape : mergeShapesAt(items, elementShape, depth + 1);
    }
    return { kind: "array", items: items ?? JSON_SHAPE };
  }
  if (typeof sample === "object") {
    const fields: Record<string, ShapeType> = {};
    for (const [key, value] of Object.entries(sample)) {
      defineOwn(fields, key, deriveShapeAt(value, depth + 1));
    }
    return { kind: "object", fields };
  }
  // undefined, functions, symbols — not Json; degrade instead of throwing.
  return JSON_SHAPE;
};

/** v2 spec §3 — derive the structural shape of one recorded sample value.
 *  Total: non-Json values degrade to `json`, never a throw. */
export function deriveShape(sample: Json): ShapeType {
  return deriveShapeAt(sample, 0);
}

const mergeShapesAt = (a: ShapeType, b: ShapeType, depth: number): ShapeType => {
  if (depth >= SHAPE_MAX_DEPTH) return JSON_SHAPE;
  if (a.kind === "json" || b.kind === "json") return JSON_SHAPE;
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", items: mergeShapesAt(a.items, b.items, depth + 1) };
  }
  if (a.kind === "object" && b.kind === "object") {
    const fields: Record<string, ShapeType> = {};
    const optional: string[] = [];
    const aOptional = new Set(a.optional ?? []);
    const bOptional = new Set(b.optional ?? []);
    const bFields = new Set(Object.keys(b.fields));
    for (const [key, shape] of Object.entries(a.fields)) {
      const other = bFields.has(key)
        ? (b.fields as Record<string, ShapeType | undefined>)[key]
        : undefined;
      defineOwn(fields, key, other === undefined ? shape : mergeShapesAt(shape, other, depth + 1));
      if (other === undefined || aOptional.has(key) || bOptional.has(key)) optional.push(key);
    }
    for (const [key, shape] of Object.entries(b.fields)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) continue;
      defineOwn(fields, key, shape);
      optional.push(key);
    }
    return optional.length > 0 ? { kind: "object", fields, optional } : { kind: "object", fields };
  }
  if (a.kind === b.kind && a.kind !== "object" && a.kind !== "array") return { kind: a.kind };
  return JSON_SHAPE;
};

/** v2 spec §3 — union two shapes (multi-sample derivation): objects merge
 *  field-wise with one-sided fields optional, arrays merge item-wise,
 *  anything mismatched degrades to `json`. */
function mergeShapes(a: ShapeType, b: ShapeType): ShapeType {
  return mergeShapesAt(a, b, 0);
}

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
  return shape.kind;
};

/** v2 spec §3 — the compact notation the engine embeds in the model's tool
 *  context (e.g. `{ month: string, revenue: number }[]`). Deterministic,
 *  depth-bounded (`…` beyond {@link DESCRIBE_MAX_DEPTH}). */
export function describeShape(shape: ShapeType): string {
  return describeShapeAt(shape, DESCRIBE_MAX_DEPTH);
}

/** v2 spec §3 — build one tool's shape card from recorded samples ("values
 *  hashed away" — only the merged structure is kept). No samples ⇒ the
 *  unknown `json` shape. This is the `vendo sync` / recorded-sample seam:
 *  whoever records responses calls this; core stays I/O-free. */
export function deriveShapeCard(tool: string, samples: readonly Json[], sampledAt?: IsoDateTime): ShapeCard {
  let output: ShapeType | undefined;
  for (const sample of samples) {
    const shape = deriveShape(sample);
    output = output === undefined ? shape : mergeShapes(output, shape);
  }
  return {
    tool,
    output: output ?? JSON_SHAPE,
    source: "sample",
    ...(sampledAt === undefined ? {} : { sampledAt }),
  };
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
    const first = values[0];
    if (typeof first === "string") return { kind: "string", enum: values };
    if (typeof first === "number") return { kind: "number", enum: values };
    if (typeof first === "boolean") return { kind: "boolean", enum: values };
  }
  return JSON_SHAPE;
};

/**
 * A DECLARED JSON Schema in the checks' structural form — the producer of
 * `toolShapes` now that nothing samples. Total: unmodelled constructs (anyOf,
 * $ref, custom keywords) degrade to `{ kind: "json" }`, never a throw.
 * `enum`/`const` SURVIVE onto the scalar branch: an enum erased to a bare
 * `string` is what refused a correct screen at the checks floor (live 2026-08,
 * demo-bank's spending donut).
 */
export function shapeFromJsonSchema(schema: JsonSchema): ShapeType {
  return shapeFromJsonSchemaAt(schema, 0);
}
