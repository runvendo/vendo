import { z } from "zod";
import type { IsoDateTime, Json } from "./ids.js";
import { defineOwn } from "./tree.js";

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
 * binding type-check (wire-v2/shape-check.ts).
 */
export type ShapeType =
  | { kind: "string" | "number" | "boolean" | "null" | "json" }
  | { kind: "array"; items: ShapeType }
  | { kind: "object"; fields: Record<string, ShapeType>; optional?: string[] };

/** v2 spec §3 — structural shape only (the types+zod pairing convention). */
const shapeTypeSchema: z.ZodType<ShapeType> = z.lazy(() => z.union([
  z.object({ kind: z.enum(["string", "number", "boolean", "null", "json"]) }),
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
function deriveShape(sample: Json): ShapeType {
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
 *  (wire-v2/shape-check.ts). */
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
