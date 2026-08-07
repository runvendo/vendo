import { z } from "zod";
import { describeShape, enumText, type ShapeType } from "./shape.js";

/**
 * W3 (v3 spec §Context) — field semantics: what a tool-response field MEANS
 * (cents money, ISO date, enum vocabulary, id, percent scale), beyond its
 * structural shape. Carried per tool inside `.vendo/tools.json` (the machine
 * layer, overlaid by the host's `overrides.json` annotations) and consumed by
 * generation context (annotated shape cards), the compile-time law checks, and
 * the Kit's format defaults.
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

// ---------------------------------------------------------------------------
// Inference (name patterns + sampled values; conservative — anything unsure
// stays plain and is simply omitted from the file).
// ---------------------------------------------------------------------------

const CENTS_NAME = /cents$/i;
// "total" alone is NOT a money signal: documentsTotal / clientsTotal /
// pagination totals are counts (cubic P1 on the Cadence artifact). A total
// classifies as money only through a money token (totalAmount, totalCents).
const MONEY_NAME = /(amount|balance|price|cost|fee|revenue|spend|paid|budget)/i;
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

// ---------------------------------------------------------------------------
// Declaration (input args). Not inference: the caller has one value, and a
// magnitude cannot tell cents from dollars.
// ---------------------------------------------------------------------------

// The same two regexes `amountUnitIssue` (packages/apps/src/call.ts) and
// `unitAnnotation` (apps generation contracts) already classify unit metadata
// with. Kept here so the consent surface reads the host's declaration through
// the same rule the call seam enforces it with.
const CENTS_DESCRIPTION = /\bcents\b|\bminor units?\b/i;
const DOLLARS_DESCRIPTION = /\bdollars\b/i;

/**
 * What the HOST declared about one tool-input field's money unit.
 *
 * `"cents"` / `"dollars"` — declared, in the property's description or by a
 * name that states its own unit (`amountCents`). `"unknown"` — the field is
 * money-shaped but nobody said in which unit, so a renderer must NOT present it
 * as an amount. `undefined` — not money at all; leave it alone.
 *
 * Wave-1 live proof E2c is why this exists: a $47.50 payment's consent card
 * rendered `amount 4750`, which reads as $4,750 — a 100× misread on the one
 * surface that gates irreversible money movement. Declaration only, never a
 * guess from the value: mislabelling a non-money integer as currency would be
 * the same defect pointing the other way.
 */
export function declaredMoneyUnit(
  field: string,
  schema: Record<string, unknown> | undefined,
): "cents" | "dollars" | "unknown" | undefined {
  const named = CENTS_NAME.test(field) ? "cents" as const : undefined;
  if (named === undefined && !(MONEY_NAME.test(field) && !NOT_MONEY_NAME.test(field))) return undefined;
  const description = typeof schema?.description === "string" ? schema.description : "";
  const saysCents = CENTS_DESCRIPTION.test(description);
  const saysDollars = DOLLARS_DESCRIPTION.test(description);
  // Contradictory metadata declares nothing — `unitAnnotation`'s own rule.
  const described = saysCents === saysDollars ? undefined : saysCents ? "cents" as const : "dollars" as const;
  if (named !== undefined && described !== undefined && named !== described) return "unknown";
  return named ?? described ?? "unknown";
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

const describeAt = (
  shape: ShapeType,
  semantics: ToolSemantics,
  path: string,
  depth: number,
  renderEnum: boolean,
): string => {
  if (depth <= 0) return "…";
  if (shape.kind === "json") return "Json";
  if (shape.kind === "array") return `${describeAt(shape.items, semantics, path, depth - 1, renderEnum)}[]`;
  if (shape.kind === "object") {
    const optional = new Set(shape.optional ?? []);
    const entries = Object.entries(shape.fields).map(([key, field]) => {
      const childPath = path === "" ? key : `${path}.${key}`;
      const semantic = Object.prototype.hasOwnProperty.call(semantics, childPath) ? semantics[childPath] : undefined;
      const claimed = semantic !== undefined && semantic.kind !== "plain";
      const annotation = claimed ? `:${describeSemantic(semantic)}` : "";
      // A claimed field is described by its semantic; only an UNCLAIMED one
      // falls back to spelling its schema enum out.
      return `${key}${optional.has(key) ? "?" : ""}: ${describeAt(field, semantics, childPath, depth - 1, !claimed)}${annotation}`;
    });
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return (renderEnum ? enumText(shape.enum) : undefined) ?? shape.kind;
};

/** {@link describeShape}, with each classified field annotated
 *  (`amountCents: number:money.cents`). Identical to describeShape when no
 *  semantics apply. */
export function describeShapeWithSemantics(shape: ShapeType, semantics: ToolSemantics): string {
  if (Object.keys(semantics).length === 0) return describeShape(shape);
  return describeAt(shape, semantics, "", DESCRIBE_MAX_DEPTH, true);
}

/** The Kit value-format token a semantic implies (DataTable column format,
 *  Stat format, chart format defaults). Undefined = no format default. */
export function semanticFormatToken(semantic: FieldSemantic): "money" | "date" | "percent" | "number" | undefined {
  if (semantic.kind === "money") return "money";
  if (semantic.kind === "date") return "date";
  if (semantic.kind === "percent") return "percent";
  return undefined;
}
