import { sha256Hex, type JsonSchema } from "@vendoai/core";

/**
 * Synthesize preview props from a component's DECLARED props schema — rung 2 of
 * the preview seed ladder (rung 1 is the host's own `examples`, rung 3 is an
 * honest "no sample data" label).
 *
 * Most hosts never write `examples`, but nearly all of them declare `props:`
 * next to the component, and sync already interprets that into JSON Schema for
 * `catalog.json`. Reusing it means a preview draws for essentially every
 * registered component instead of only the documented few.
 *
 * DETERMINISM IS A HARD REQUIREMENT, not a nicety: `.vendo/components/` is
 * committed, and anything random would rewrite the corpus on every sync — the
 * churn class this lane has already had to fix twice. Every value is derived
 * from `sha256(componentName + property path)`, so the same schema always
 * produces the same bytes, and two different components never produce the same
 * filler.
 *
 * The output is PLAUSIBLE, not pretty. It is typed-correct against the declared
 * schema and stable; that is the whole bar.
 */

/** Depth past which a schema is treated as unrepresentable (recursion guard). */
const MAX_DEPTH = 8;
/** Elements to synthesize for an unbounded array — enough that a chart or table
 *  has a shape, few enough to keep the corpus small. */
const DEFAULT_ARRAY_ITEMS = 3;

type Generated = { ok: true; value: unknown } | { ok: false };

const FAILED: Generated = { ok: false };

/** A stable 32-bit number for one (component, path) pair. */
function seedOf(name: string, path: string): number {
  return Number.parseInt(sha256Hex(`${name}\0${path}`).slice(0, 8), 16);
}

const pick = <T>(values: readonly T[], seed: number): T => values[seed % values.length]!;

/** Filler words that read like product data rather than lorem ipsum. */
const WORDS = ["Acme", "Northwind", "Contoso", "Globex", "Initech", "Umbrella"] as const;
const LABELS = ["Groceries", "Dining", "Transport", "Utilities", "Payroll", "Software"] as const;
const NAMES = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson"] as const;
const STATUSES = ["active", "pending", "review", "complete"] as const;

/** Keys whose NAME tells us more than their type does. Cheap, and the
 *  difference between a preview that reads like a product and one that reads
 *  like a type test. */
function stringFor(key: string, seed: number, schema: JsonSchema): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  if (format === "date-time") return new Date(Date.UTC(2026, 0, 1 + (seed % 28))).toISOString();
  if (format === "email") return `${pick(["ada", "grace", "alan"], seed)}@example.com`;
  if (format === "uri") return "https://example.com";
  if (format === "uuid") {
    const hex = sha256Hex(String(seed)).slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  const value = /id$/i.test(key) ? `${key.toLowerCase()}_${sha256Hex(String(seed)).slice(0, 8)}`
    : /(name|owner|author|customer|client)/i.test(key) ? pick(NAMES, seed)
      : /(category|label|tag|kind)/i.test(key) ? pick(LABELS, seed)
        : /(status|state)/i.test(key) ? pick(STATUSES, seed)
          : /(currency)/i.test(key) ? "USD"
            : /(title|heading|description|text|message)/i.test(key) ? `${pick(LABELS, seed)} ${pick(["summary", "overview", "update"], seed)}`
              : pick(WORDS, seed);
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  const padded = value.length >= min ? value : value.padEnd(min, "x");
  return max !== undefined && padded.length > max ? padded.slice(0, max) : padded;
}

function numberFor(key: string, seed: number, schema: JsonSchema): number {
  const integer = schema.type === "integer";
  // Money is the most common numeric prop in a host registry and reads wrong at
  // single digits; counts read wrong in the thousands.
  const base = /(cents|amount|balance|price|revenue|salary|cost)/i.test(key) ? 10_000 + (seed % 990_000)
    : /(count|qty|quantity|size|height|width|index|page|days?)/i.test(key) ? 1 + (seed % 48)
      : /(percent|rate|ratio)/i.test(key) ? seed % 100
        : 1 + (seed % 1_000);
  const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
  let value = base;
  if (min !== undefined && max !== undefined) value = max <= min ? min : min + (seed % Math.max(1, Math.floor(max - min) + 1));
  else if (min !== undefined && value < min) value = min + (seed % 100);
  else if (max !== undefined && value > max) value = max - (seed % 10) < (min ?? Number.NEGATIVE_INFINITY) ? max : max - (seed % 10);
  return integer ? Math.round(value) : value;
}

/** Names that mean "the ceiling" and names that mean "where we are now". */
const CEILING = /^(?:max|maximum|total|limit|capacity|goal|target|denominator)$/i;
const CURRENT = /^(?:value|current|count|used|completed|done|progress|numerator)$/i;

/**
 * Keep obviously-paired numbers in a sane relationship. Each value is generated
 * independently from its own path, so a progress bar could come out as
 * `value: 554008, max: 228` — typed-correct and visibly broken, which in a
 * preview is worse than no seed at all. Only reorders what is already there;
 * invents nothing.
 */
function coherePairs(value: Record<string, unknown>): void {
  const ceiling = Object.keys(value).find((key) => CEILING.test(key));
  const current = Object.keys(value).find((key) => CURRENT.test(key));
  if (ceiling === undefined || current === undefined) return;
  const high = value[ceiling];
  const low = value[current];
  if (typeof high !== "number" || typeof low !== "number" || low <= high) return;
  value[ceiling] = high > low ? high : low;
  value[current] = Math.max(1, Math.round(low % Math.max(2, high)));
}

function generate(schema: JsonSchema, key: string, name: string, path: string, depth: number): Generated {
  if (depth > MAX_DEPTH) return FAILED;
  const seed = seedOf(name, path);

  if (schema.const !== undefined) return { ok: true, value: schema.const };
  if (Array.isArray(schema.enum)) {
    return schema.enum.length === 0 ? FAILED : { ok: true, value: pick(schema.enum, seed) };
  }
  if (Array.isArray(schema.anyOf)) {
    for (const [index, variant] of schema.anyOf.entries()) {
      // Skip the null arm of a nullable union so the preview has real data.
      if ((variant as JsonSchema).type === "null" && schema.anyOf.length > 1) continue;
      const generated = generate(variant as JsonSchema, key, name, `${path}/anyOf/${index}`, depth + 1);
      if (generated.ok) return generated;
    }
    return FAILED;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "string") return { ok: true, value: stringFor(key, seed, schema) };
  if (type === "number" || type === "integer") return { ok: true, value: numberFor(key, seed, schema) };
  if (type === "boolean") return { ok: true, value: seed % 2 === 0 };
  if (type === "null") return { ok: true, value: null };

  if (type === "array") {
    if (Array.isArray(schema.prefixItems)) {
      const tuple: unknown[] = [];
      for (const [index, item] of schema.prefixItems.entries()) {
        const generated = generate(item as JsonSchema, key, name, `${path}/${index}`, depth + 1);
        if (!generated.ok) return FAILED;
        tuple.push(generated.value);
      }
      return { ok: true, value: tuple };
    }
    const items = schema.items as JsonSchema | undefined;
    // An array whose element type is unknown can only be `[]`, and a component
    // that guards on `.length` would render nothing — the exact failure the
    // seed exists to prevent. Fail instead, so the caller can drop an optional
    // prop or fall to an honest label.
    if (items === undefined || Object.keys(items).length === 0) return FAILED;
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
    const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : Number.POSITIVE_INFINITY;
    const count = Math.max(minItems, Math.min(DEFAULT_ARRAY_ITEMS, maxItems));
    const values: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const generated = generate(items, key, name, `${path}/${index}`, depth + 1);
      if (!generated.ok) return FAILED;
      values.push(generated.value);
    }
    return { ok: true, value: values };
  }

  if (type === "object" || schema.properties !== undefined) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    const value: Record<string, unknown> = {};
    for (const propertyKey of Object.keys(properties).sort()) {
      const generated = generate(properties[propertyKey]!, propertyKey, name, `${path}/${propertyKey}`, depth + 1);
      // A required property we cannot synthesize makes the whole object
      // unusable; an optional one is simply left out.
      if (!generated.ok) {
        if (required.has(propertyKey)) return FAILED;
        continue;
      }
      value[propertyKey] = generated.value;
    }
    // An EMPTY object where the schema expected data is the same blank-render
    // trap as an empty array: `if (!rows?.length) return null` draws nothing and
    // the surface spins. That happens two ways — a `z.record()` (no declared
    // properties, an open value schema) and an all-optional object whose every
    // property failed to synthesize. Both fall to the honest rung-3 label.
    // A component that genuinely declares NO props is different: `{}` is the
    // correct seed and it will draw.
    coherePairs(value);
    const expectedData = Object.keys(properties).length > 0
      || (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null);
    if (expectedData && Object.keys(value).length === 0) return FAILED;
    return { ok: true, value };
  }

  // No type, no enum, no const, no properties: the permissive placeholder sync
  // writes when it could not interpret a schema. Nothing to synthesize.
  return FAILED;
}

/**
 * Deterministic preview props for one component, or null when its declared
 * schema cannot be represented (recursive, opaque, or the permissive
 * placeholder). `name` seeds every value, so two components never share filler.
 */
export function generateSampleProps(name: string, schema: JsonSchema | undefined): Record<string, unknown> | null {
  if (schema === undefined || Object.keys(schema).length === 0) return null;
  const generated = generate(schema, "", name, "", 0);
  if (!generated.ok) return null;
  const value = generated.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
