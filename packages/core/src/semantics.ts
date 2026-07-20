import { z } from "zod";
import type { Json } from "./ids.js";
import { describeShape, type ShapeType } from "./shape.js";

/**
 * W3 (v3 spec §Context) — field semantics: what a tool-response field MEANS
 * (cents money, ISO date, enum vocabulary, id, percent scale), beyond its
 * structural shape. Derived ONCE at `vendo sync` into the reviewable
 * `.vendo/semantics.json` (host annotation > one-time inference > plain) and
 * consumed by generation context (annotated shape cards), the compile-time
 * law checks, and the Kit's format defaults.
 */
export type FieldSemantic =
  | { kind: "money"; unit: "cents" | "dollars"; currency?: string }
  | { kind: "date"; format: "iso" | "epoch" }
  | { kind: "enum"; labels: Record<string, string> }
  | { kind: "id"; entity?: string }
  | { kind: "percent"; scale: "ratio" | "0-100" }
  | { kind: "plain" };

export const fieldSemanticSchema: z.ZodType<FieldSemantic> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), unit: z.enum(["cents", "dollars"]), currency: z.string().optional() }),
  z.object({ kind: z.literal("date"), format: z.enum(["iso", "epoch"]) }),
  z.object({ kind: z.literal("enum"), labels: z.record(z.string()) }),
  z.object({ kind: z.literal("id"), entity: z.string().optional() }),
  z.object({ kind: z.literal("percent"), scale: z.enum(["ratio", "0-100"]) }),
  z.object({ kind: z.literal("plain") }),
]) as z.ZodType<FieldSemantic>;

/** One tool's field semantics, keyed by COLLAPSED dot path into the response:
 *  object fields by name, array levels collapsed (no numeric segments) —
 *  `data.amountCents` covers `/data/3/amountCents`. */
export type ToolSemantics = Record<string, FieldSemantic>;

export const toolSemanticsSchema: z.ZodType<ToolSemantics> = z.record(fieldSemanticSchema);

/** The domain manifest: what data domains this host covers (derived from tool
 *  names at sync, host-editable) and what it explicitly does NOT — surfaced
 *  to generation as fact so an out-of-domain ask gets a Disclaimer, never
 *  invented data. */
export interface DomainManifest {
  has: string[];
  hasNot: string[];
}

export const domainManifestSchema: z.ZodType<DomainManifest> = z.object({
  has: z.array(z.string()),
  hasNot: z.array(z.string()),
});

export const VENDO_SEMANTICS_FORMAT = "vendo/semantics@1" as const;

/** `.vendo/semantics.json` — generated at sync, REVIEWABLE and host-editable:
 *  sync preserves existing entries (inference runs once per field) and hosts
 *  may correct any entry or extend `domains`. */
export interface SemanticsFile {
  format: typeof VENDO_SEMANTICS_FORMAT;
  tools: Record<string, ToolSemantics>;
  domains: DomainManifest;
}

export const semanticsFileSchema = z.object({
  format: z.literal(VENDO_SEMANTICS_FORMAT),
  tools: z.record(toolSemanticsSchema),
  domains: domainManifestSchema,
}).passthrough() satisfies z.ZodType<SemanticsFile>;

// ---------------------------------------------------------------------------
// Inference (name patterns + sampled values; conservative — anything unsure
// stays plain and is simply omitted from the file).
// ---------------------------------------------------------------------------

const CENTS_NAME = /cents$/i;
const MONEY_NAME = /(amount|balance|total|price|cost|fee|revenue|spend|paid|budget)/i;
const NOT_MONEY_NAME = /(count|qty|quantity|number|num$|id$|rate|ratio|pct|percent)/i;
const DATE_NAME = /(date|time|timestamp|at)$/i;
const ID_NAME = /^id$|(.)Id$|_id$/;
const ENUM_NAME = /(status|state|type|kind|tier|category|risk|priority|severity|frequency|method|level)$/i;
const PERCENT_NAME = /(percent|pct|rate|ratio|progress|utilization|share)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const ENUM_TOKEN = /^[a-z][a-z0-9_-]*$/i;
const MAX_ENUM_VALUES = 12;

const isEpoch = (value: number): boolean =>
  Number.isInteger(value)
  && ((value >= 1e9 && value < 3e9) || (value >= 1e12 && value < 3e12));

/** past_due → "Past due"; APPROVED → "Approved". */
export const humanizeEnumValue = (value: string): string => {
  const words = value.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words.length === 0 ? value : words[0]!.toUpperCase() + words.slice(1);
};

/** Infer ONE field's semantic from its name and its sampled values (nulls
 *  ignored). Conservative: mixed types or unconvincing values ⇒ plain. */
export function inferFieldSemantic(name: string, values: readonly unknown[]): FieldSemantic {
  const present = values.filter((value) => value !== null && value !== undefined);
  const strings = present.filter((value): value is string => typeof value === "string");
  const numbers = present.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const allStrings = present.length > 0 && strings.length === present.length;
  const allNumbers = present.length > 0 && numbers.length === present.length;

  const idMatch = ID_NAME.exec(name);
  if (idMatch !== null && (present.length === 0 || allStrings || allNumbers)) {
    const entity = name === "id" ? undefined : name.replace(/(Id|_id)$/, "");
    return entity === undefined || entity.length === 0 ? { kind: "id" } : { kind: "id", entity: entity.toLowerCase() };
  }
  if (CENTS_NAME.test(name) && (present.length === 0 || allNumbers)) {
    return { kind: "money", unit: "cents" };
  }
  if (allStrings && strings.every((value) => ISO_DATE.test(value))) {
    // ISO-formatted values are decisive on their own, whatever the name.
    return { kind: "date", format: "iso" };
  }
  if (DATE_NAME.test(name) && allNumbers && numbers.every(isEpoch)) {
    return { kind: "date", format: "epoch" };
  }
  if (PERCENT_NAME.test(name) && allNumbers) {
    if (numbers.every((value) => value >= 0 && value <= 1)) return { kind: "percent", scale: "ratio" };
    if (numbers.every((value) => value >= 0 && value <= 100)) return { kind: "percent", scale: "0-100" };
  }
  if (ENUM_NAME.test(name) && allStrings) {
    const distinct = [...new Set(strings)];
    if (distinct.length <= MAX_ENUM_VALUES && distinct.every((value) => ENUM_TOKEN.test(value))) {
      const labels: Record<string, string> = {};
      for (const value of distinct.sort()) labels[value] = humanizeEnumValue(value);
      return { kind: "enum", labels };
    }
  }
  if (MONEY_NAME.test(name) && !NOT_MONEY_NAME.test(name) && allNumbers) {
    return numbers.some((value) => !Number.isInteger(value))
      ? { kind: "money", unit: "dollars" }
      : { kind: "money", unit: "cents" };
  }
  return { kind: "plain" };
}

/** Collect sampled values per collapsed dot path across samples. */
const collectFieldValues = (samples: readonly Json[]): Map<string, unknown[]> => {
  const byPath = new Map<string, unknown[]>();
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, path, depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path === "" ? key : `${path}.${key}`;
        if (child === null || typeof child !== "object") {
          const bucket = byPath.get(childPath) ?? [];
          bucket.push(child);
          byPath.set(childPath, bucket);
        } else {
          visit(child, childPath, depth + 1);
        }
      }
    }
  };
  for (const sample of samples) visit(sample, "", 0);
  return byPath;
};

/** Infer a whole tool response's field semantics from recorded samples.
 *  Plain fields are omitted (the file stays small and reviewable). */
export function inferToolSemantics(samples: readonly Json[]): ToolSemantics {
  const semantics: ToolSemantics = {};
  for (const [path, values] of collectFieldValues(samples)) {
    const name = path.split(".").pop() ?? path;
    const semantic = inferFieldSemantic(name, values);
    if (semantic.kind !== "plain") semantics[path] = semantic;
  }
  return semantics;
}

/** Resolve a binding's RFC 6901 pointer against collapsed-path semantics:
 *  numeric (array) segments drop out. */
export function semanticAtPointer(semantics: ToolSemantics, pointer: string): FieldSemantic | undefined {
  if (!pointer.startsWith("/")) return undefined;
  const path = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .filter((token) => !/^\d+$/.test(token))
    .join(".");
  return Object.prototype.hasOwnProperty.call(semantics, path) ? semantics[path] : undefined;
}

/** The compact semantic annotation appended to a field's kind in a shape
 *  card: `number:money.cents`, `string:date.iso`, `string:enum(a|b)`. */
export const describeSemantic = (semantic: FieldSemantic): string => {
  switch (semantic.kind) {
    case "money": return semantic.currency === undefined ? `money.${semantic.unit}` : `money.${semantic.unit}(${semantic.currency})`;
    case "date": return `date.${semantic.format}`;
    case "enum": return `enum(${Object.keys(semantic.labels).join("|")})`;
    case "id": return semantic.entity === undefined ? "id" : `id(${semantic.entity})`;
    case "percent": return `percent.${semantic.scale}`;
    case "plain": return "";
  }
};

const DESCRIBE_MAX_DEPTH = 6;

const describeAt = (shape: ShapeType, semantics: ToolSemantics, path: string, depth: number): string => {
  if (depth <= 0) return "…";
  if (shape.kind === "json") return "Json";
  if (shape.kind === "array") return `${describeAt(shape.items, semantics, path, depth - 1)}[]`;
  if (shape.kind === "object") {
    const optional = new Set(shape.optional ?? []);
    const entries = Object.entries(shape.fields).map(([key, field]) => {
      const childPath = path === "" ? key : `${path}.${key}`;
      const semantic = Object.prototype.hasOwnProperty.call(semantics, childPath) ? semantics[childPath] : undefined;
      const annotation = semantic === undefined || semantic.kind === "plain" ? "" : `:${describeSemantic(semantic)}`;
      return `${key}${optional.has(key) ? "?" : ""}: ${describeAt(field, semantics, childPath, depth - 1)}${annotation}`;
    });
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return shape.kind;
};

/** {@link describeShape}, with each classified field annotated
 *  (`amountCents: number:money.cents`). Identical to describeShape when no
 *  semantics apply. */
export function describeShapeWithSemantics(shape: ShapeType, semantics: ToolSemantics): string {
  if (Object.keys(semantics).length === 0) return describeShape(shape);
  return describeAt(shape, semantics, "", DESCRIBE_MAX_DEPTH);
}

/** The Kit value-format token a semantic implies (DataTable column format,
 *  Stat format, chart format defaults). Undefined = no format default. */
export function semanticFormatToken(semantic: FieldSemantic): "money" | "date" | "percent" | "number" | undefined {
  if (semantic.kind === "money") return "money";
  if (semantic.kind === "date") return "date";
  if (semantic.kind === "percent") return "percent";
  return undefined;
}
