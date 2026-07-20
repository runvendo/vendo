import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  loadTypescript,
  localInitializer,
  MAX_RESOLVE_DEPTH,
  parseModule,
  zodFromExpression,
  type StaticExtraction,
  type ZodSchemaResult,
} from "./static-ts.js";

/**
 * Differential harness: the mimic (`zodFromExpression`, a static TS-AST
 * reader that never executes host code) vs. the oracle (real zod +
 * zod-to-json-schema, evaluated against the same snippet). The fixture
 * snippets below are ours, not host input — evaluating them with `Function`
 * is safe and intended (see `oracleRead`).
 */

type CaseMode = "match" | "divergent" | "permissive";

interface BaseCase {
  name: string;
  snippet: string;
  /** Expected `mimic.optional` for this row. Defaults to false; only the
   * `void`/`undefined` constructors return true (04 §1: an absent-argument
   * signal with no parent `required` array to hang it off of here). */
  optional?: boolean;
}

/** The mimic and the normalized oracle output must be structurally identical. */
interface MatchCase extends BaseCase {
  mode: "match";
}

/** The mimic and the oracle intentionally disagree (or the oracle can't
 * represent the row's concept at all). Both sides are pinned literally so a
 * future zod-to-json-schema upgrade that shifts oracle behavior still fails
 * the test instead of silently drifting. */
interface DivergentCase extends BaseCase {
  mode: "divergent";
  /** The mimic's exact `schema` output for this snippet. */
  expectedStatic: Record<string, unknown>;
  /** The normalized oracle's exact output for this snippet. */
  expectedOracle: Record<string, unknown>;
}

/** The mimic fails closed: `recognized: false` with a diagnostic reason.
 * These rows never call `oracleRead` — some snippets aren't even valid
 * runtime zod (unresolved identifiers, depth-exhausting nesting), so there
 * is nothing for the oracle to evaluate. Only the reason's stable substring
 * is asserted, since the prose itself isn't a stable contract. */
interface PermissiveCase extends BaseCase {
  mode: "permissive";
  /** Substring the mimic's `reason` must contain (not an exact match — the
   * message text is prose and may be reworded). */
  reasonIncludes: string;
}

type OracleCase = MatchCase | DivergentCase | PermissiveCase;

/** Feeds `snippet` through the static interpreter, wrapped as a one-line module. */
async function staticRead(snippet: string): Promise<ZodSchemaResult> {
  const ts = loadTypescript(process.cwd());
  if (!ts) throw new Error("typescript compiler could not be resolved for the oracle harness");
  const extraction: StaticExtraction = { ts, root: process.cwd(), modules: new Map() };
  const source = `import z from "zod";\nconst schema = ${snippet};\n`;
  const module = parseModule(extraction, "/virtual/schema.ts", source);
  const expr = localInitializer(extraction, module, "schema");
  if (!expr) throw new Error("fixture bug: `schema` initializer not found in the wrapped snippet");
  return zodFromExpression(extraction, module, expr, 0);
}

/** Evaluates `snippet` with real zod and converts with the reference library.
 * `$refStrategy: "none"` keeps output inline (the mimic never emits $ref);
 * `dateStrategy: "format:date-time"` matches the mimic's z.date() output. */
function oracleRead(snippet: string): Record<string, unknown> {
  const build = new Function("z", `return (${snippet});`) as (zod: typeof z) => z.ZodTypeAny;
  const schema = build(z);
  return zodToJsonSchema(schema, { $refStrategy: "none", dateStrategy: "format:date-time" }) as Record<string, unknown>;
}

type JsonSchemaLike = Record<string, unknown>;

/** Collapses the oracle's raw output onto the mimic's shape. Exactly three
 * transforms, each representational (drops/renames a wire detail the mimic
 * never emits) rather than semantic (changing what the schema accepts). */
function normalizeOracle(schema: JsonSchemaLike): JsonSchemaLike {
  const { $schema: _drop, ...rest } = schema; // (a) meta-pointer the mimic never emits
  return normalizeNode(rest) as JsonSchemaLike;
}

function normalizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNode);
  if (value === null || typeof value !== "object") return value;
  const node = value as JsonSchemaLike;

  // (b) a two-element [T, "null"] type array is the oracle's nullable
  // encoding; rewrite it as the mimic's anyOf-with-null form. The oracle
  // flattens `.describe("m").nullable()` and `.nullable().describe("m")` to
  // the same {type:[T,"null"],description:"m"} shape, but the mimic places
  // the annotation differently depending on order (inner branch vs. the
  // anyOf wrapper) — this rewrite can only match one of them. Convention:
  // sibling keys are assumed to predate `.nullable()` (describe-before-
  // nullable), so they land on the T-typed branch below. Author "match" rows
  // in that order; nullable-last-with-annotations is a "divergent" case for
  // a later task, not something this transform tries to detect or handle.
  if (Array.isArray(node.type) && node.type.length === 2 && node.type.includes("null")) {
    const innerType = node.type.find((candidate) => candidate !== "null");
    const { type: _split, ...withoutType } = node;
    return {
      anyOf: [normalizeNode({ ...withoutType, type: innerType }), { type: "null" }],
    };
  }

  const out: JsonSchemaLike = {};
  for (const [key, entry] of Object.entries(node)) {
    // (c) `type` beside `const` is redundant — the const value alone fixes the type.
    if (key === "type" && "const" in node) continue;
    // `properties` values are host field names, not JSON Schema keywords — a
    // field literally named "type" must not be eaten by transform (c) above,
    // so recurse into the map without applying keyword transforms to it.
    out[key] = key === "properties" ? normalizePropertiesMap(entry) : normalizeNode(entry);
  }
  return out;
}

function normalizePropertiesMap(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const map = value as JsonSchemaLike;
  const out: JsonSchemaLike = {};
  for (const [key, entry] of Object.entries(map)) out[key] = normalizeNode(entry);
  return out;
}

const cases: OracleCase[] = [
  // --- smoke (kitchen-sink shapes) ---------------------------------------
  {
    name: "object with int/min and optional string",
    snippet: "z.object({ amount: z.number().int().min(1), memo: z.string().optional() })",
    mode: "match",
  },
  {
    name: "object with nested object and required/optional mix",
    snippet: "z.object({ a: z.object({ b: z.string() }), c: z.string().optional() })",
    mode: "match",
  },

  // --- base constructors -----------------------------------------------
  { name: "string constructor", snippet: "z.string()", mode: "match" },
  { name: "number constructor", snippet: "z.number()", mode: "match" },
  {
    // DIVERGENT: zod-to-json-schema adds `format: "int64"` for z.bigint().
    // JS bigint is arbitrary precision, so a fixed 64-bit wire format isn't
    // guaranteed accurate; the mimic deliberately emits a plain integer
    // rather than asserting a width bound we can't verify.
    name: "bigint constructor (oracle adds int64 format, mimic stays plain integer)",
    snippet: "z.bigint()",
    mode: "divergent",
    expectedStatic: { type: "integer" },
    expectedOracle: { type: "integer", format: "int64" },
  },
  { name: "boolean constructor", snippet: "z.boolean()", mode: "match" },
  { name: "date constructor", snippet: "z.date()", mode: "match" },
  { name: "null constructor", snippet: "z.null()", mode: "match" },
  { name: "any constructor", snippet: "z.any()", mode: "match" },
  { name: "unknown constructor", snippet: "z.unknown()", mode: "match" },
  {
    // Bare z.void() at top level: both sides happen to agree on an empty
    // schema body, so this stays "match" — only the mimic's `optional: true`
    // (asserted below via the row) carries the "absent argument" signal;
    // JSON Schema has no top-level concept of optionality to compare against.
    name: "void constructor (top-level optional, no parent required array)",
    snippet: "z.void()",
    mode: "match",
    optional: true,
  },
  {
    // DIVERGENT: zod-to-json-schema encodes z.undefined() as `{ not: {} }`
    // (a schema that matches nothing — JSON Schema has no "undefined" type
    // to encode positively). The mimic instead treats a bare z.undefined()
    // as an always-omissible passthrough field (schema {}, optional: true),
    // which is what 04 §1's derivation actually needs (a field that may be
    // left out), not a literal "matches no value" constraint.
    name: "undefined constructor (top-level optional; oracle encodes impossible-match)",
    snippet: "z.undefined()",
    mode: "divergent",
    optional: true,
    expectedStatic: {},
    expectedOracle: { not: {} },
  },
  { name: "literal string", snippet: 'z.literal("a")', mode: "match" },
  // Confirmed empirically NOT divergent: the oracle emits `type` beside
  // `const` for a numeric literal, but transform (c) already strips it.
  { name: "literal number", snippet: "z.literal(5)", mode: "match" },
  { name: "enum constructor", snippet: 'z.enum(["a", "b"])', mode: "match" },
  { name: "array (typed)", snippet: "z.array(z.string())", mode: "match" },
  { name: "array (untyped)", snippet: "z.array()", mode: "match" },
  {
    // Object-typed union options, not primitives: zod-to-json-schema
    // collapses a primitives-only union (e.g. string | number) into a
    // compact `{ type: [...] }` array instead of `anyOf`, which the mimic
    // never produces and the normalizer's transform (b) doesn't cover
    // (it only rewrites a 2-element type array that includes "null").
    // Object variants keep the oracle on the `anyOf` form the mimic emits.
    name: "union of object variants",
    snippet: "z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])",
    mode: "match",
  },
  {
    name: "discriminatedUnion constructor",
    snippet:
      'z.discriminatedUnion("kind", [z.object({ kind: z.literal("a"), a: z.string() }), z.object({ kind: z.literal("b"), b: z.number() })])',
    mode: "match",
  },
  { name: "record (typed value)", snippet: "z.record(z.string())", mode: "match" },
  {
    // Renamed from "record (untyped value)": bare `z.record()` throws in
    // real zod (it requires a value schema), so the mimic's no-argument
    // fallback branch (`zodBase`'s `record` case, `!valueArgument`) has no
    // corresponding runtime snippet — it is oracle-untestable. This row
    // exercises the argument-present path instead.
    name: "record (any-typed value)",
    snippet: "z.record(z.any())",
    mode: "match",
  },
  { name: "z.coerce.number()", snippet: "z.coerce.number()", mode: "match" },

  // --- modifiers (each inside an object property, so `required` reacts) --
  {
    // AUTHORING CONVENTION (transform (b)): annotations go BEFORE
    // .nullable(), never after — nullable-last is a known normalizer limit
    // deferred to a later task, not exercised here.
    name: "describe + nullable (annotation before nullable)",
    snippet: 'z.object({ note: z.string().describe("a note").nullable() })',
    mode: "match",
  },
  { name: "nullish modifier", snippet: "z.object({ note: z.string().nullish() })", mode: "match" },
  { name: "default modifier", snippet: 'z.object({ note: z.string().default("hi") })', mode: "match" },
  { name: "min/max on string", snippet: "z.object({ note: z.string().min(2).max(10) })", mode: "match" },
  { name: "min/max on number", snippet: "z.object({ qty: z.number().min(1).max(100) })", mode: "match" },
  { name: "min/max on array", snippet: "z.object({ tags: z.array(z.string()).min(1).max(5) })", mode: "match" },
  { name: "email modifier", snippet: "z.object({ contact: z.string().email() })", mode: "match" },
  { name: "uuid modifier", snippet: "z.object({ id: z.string().uuid() })", mode: "match" },
  { name: "url modifier", snippet: "z.object({ site: z.string().url() })", mode: "match" },
  { name: "datetime modifier", snippet: "z.object({ when: z.string().datetime() })", mode: "match" },

  // --- passthrough modifiers (ZOD_PASSTHROUGH_MODIFIERS; kill-list §B1: ---
  // --- unproven modifiers fail closed to passthrough on the wire type) ---
  // Each of the 11 modifiers in ZOD_PASSTHROUGH_MODIFIERS gets one row.
  // Where the oracle also leaves the wire type unchanged, the row is
  // "match"; where the oracle adds a constraint the mimic deliberately
  // drops, the row is "divergent" with both sides pinned literally.
  { name: "trim passthrough modifier", snippet: "z.object({ note: z.string().trim() })", mode: "match" },
  {
    // refine passes through the INNER schema on the mimic; the oracle does
    // the same (a refinement predicate isn't representable on the wire),
    // so this is "match", not a dropped-constraint divergence.
    name: "refine passthrough modifier",
    snippet: "z.object({ note: z.string().refine(v => v.length > 0) })",
    mode: "match",
  },
  {
    // transform passes through the INNER (pre-transform) schema on the
    // mimic; the oracle does too (zod-to-json-schema has no representation
    // for the transform function), so this is "match".
    name: "transform passthrough modifier",
    snippet: "z.object({ note: z.string().transform(v => v.toUpperCase()) })",
    mode: "match",
  },
  { name: "toUpperCase passthrough modifier", snippet: "z.object({ note: z.string().toUpperCase() })", mode: "match" },
  {
    // DIVERGENT: the oracle adds `pattern` for .regex(); the mimic
    // deliberately drops it (kill-list §B1: unproven modifiers fail closed
    // to passthrough on the wire type).
    name: "regex passthrough modifier (oracle adds pattern, mimic drops it)",
    snippet: "z.object({ note: z.string().regex(/^[a-z]+$/) })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { note: { type: "string", pattern: "^[a-z]+$" } },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    // DIVERGENT: real zod's `ZodCatch.isOptional()` returns true (a caught
    // parse always succeeds via the fallback), so the oracle drops the
    // property from `required` entirely — it never adds a literal
    // `default` keyword. The mimic's passthrough keeps the inner (pre-
    // catch) schema and its original required-ness unchanged, so "note"
    // stays required on the mimic side. Both sides pinned literally.
    name: "catch passthrough modifier (oracle drops the field from required, mimic keeps it required)",
    snippet: "z.object({ note: z.string().catch('fallback') })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { note: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    // DIVERGENT: the oracle adds `exclusiveMinimum: 0` for .positive();
    // the mimic drops it by design.
    name: "positive passthrough modifier (oracle adds exclusiveMinimum, mimic drops it)",
    snippet: "z.object({ qty: z.number().positive() })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { qty: { type: "number" } },
      required: ["qty"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { qty: { type: "number", exclusiveMinimum: 0 } },
      required: ["qty"],
      additionalProperties: false,
    },
  },
  {
    // DIVERGENT: the oracle adds `minimum: 0` for .nonnegative(); the
    // mimic drops it by design.
    name: "nonnegative passthrough modifier (oracle adds minimum, mimic drops it)",
    snippet: "z.object({ qty: z.number().nonnegative() })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { qty: { type: "number" } },
      required: ["qty"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { qty: { type: "number", minimum: 0 } },
      required: ["qty"],
      additionalProperties: false,
    },
  },
  {
    // DIVERGENT: the oracle adds `minLength`/`maxLength` for .length(); the
    // mimic drops both by design.
    name: "length passthrough modifier (oracle adds minLength/maxLength, mimic drops them)",
    snippet: "z.object({ code: z.string().length(5) })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { code: { type: "string", minLength: 5, maxLength: 5 } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    // DIVERGENT: the oracle adds `minItems: 1` for .nonempty(); the mimic
    // drops it by design.
    name: "nonempty passthrough modifier (oracle adds minItems, mimic drops it)",
    snippet: "z.object({ tags: z.array(z.string()).nonempty() })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["tags"],
      additionalProperties: false,
    },
  },
  {
    // DIVERGENT: the oracle adds a `pattern` regex for .cuid(); the mimic
    // drops it by design.
    name: "cuid passthrough modifier (oracle adds pattern, mimic drops it)",
    snippet: "z.object({ id: z.string().cuid() })",
    mode: "divergent",
    expectedStatic: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    expectedOracle: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[cC][^\\s-]{8,}$" } },
      required: ["id"],
      additionalProperties: false,
    },
  },

  // --- fail-closed (permissive: recognized:false, oracle never runs) ----
  {
    name: "unrecognized modifier: z.string().brand()",
    snippet: "z.string().brand()",
    mode: "permissive",
    reasonIncludes: "brand",
  },
  {
    name: "unrecognized constructor: z.map(...)",
    snippet: "z.map(z.string(), z.number())",
    mode: "permissive",
    reasonIncludes: "z.map",
  },
  {
    // The mimic never resolves the enum value's identity beyond a literal
    // check, so both a referenced identifier and a non-string literal hit
    // the same "non-literal value" rejection. This snippet uses a numeric
    // literal so the fixture doesn't need an undefined external binding.
    name: "non-literal enum value: z.enum([\"a\", 1])",
    snippet: 'z.enum(["a", 1])',
    mode: "permissive",
    reasonIncludes: "non-literal",
  },
  {
    // Bare identifier snippet: not even a call expression. The wrapped
    // snippet becomes `const schema = externalSchema;`, an identifier with
    // no local declaration or import for the mimic to chase — and nothing
    // for oracleRead to safely evaluate (it's an undefined reference at
    // runtime too).
    name: "unresolvable schema reference: externalSchema",
    snippet: "externalSchema",
    mode: "permissive",
    reasonIncludes: "could not be statically resolved",
  },
  {
    // Chains one modifier call beyond MAX_RESOLVE_DEPTH so the recursive
    // descent into the chain's receiver trips the depth guard. (A
    // z.array()-nesting variant was tried first but doesn't surface here:
    // zodBase's "array" case treats an unrecognized items schema as a
    // *partial* success — `{ type: "array" }` with the inner reason
    // attached — and the next level up re-wraps that via `ok()`, which
    // drops `reason` entirely, so the failure never reaches the top.
    // Modifier chaining doesn't have that swallow: `applyZodModifier`'s
    // caller does `if (!inner.recognized) return inner;`, which propagates
    // an unrecognized result untouched all the way up.)
    name: `depth exhaustion: modifier chain nested ${MAX_RESOLVE_DEPTH + 1} levels deep`,
    snippet: "z.string()" + ".optional()".repeat(MAX_RESOLVE_DEPTH + 1),
    mode: "permissive",
    reasonIncludes: "depth",
  },
];

describe("static-ts oracle differential", () => {
  for (const testCase of cases) {
    it(`${testCase.mode}: ${testCase.name}`, async () => {
      const mimic = await staticRead(testCase.snippet);

      if (testCase.mode === "permissive") {
        // Fail-closed rows: the mimic must report recognized:false with a
        // diagnostic reason, and nothing more. oracleRead is never called —
        // some of these snippets aren't even valid runtime zod.
        expect(mimic.recognized).toBe(false);
        expect(mimic.reason).toBeDefined();
        expect(mimic.reason).toContain(testCase.reasonIncludes);
        return;
      }

      // Surface the mimic's diagnostic on failure and catch partial
      // recognition (recognized:true with a reason still attached) — with
      // ~40 rows coming, `reason` is the main debugging signal.
      expect({ recognized: mimic.recognized, reason: mimic.reason }).toEqual({ recognized: true, reason: undefined });
      expect(mimic.optional).toBe(testCase.optional ?? false);
      const oracle = normalizeOracle(oracleRead(testCase.snippet));
      if (testCase.mode === "match") {
        expect(mimic.schema).toEqual(oracle);
      } else {
        expect(mimic.schema).toEqual(testCase.expectedStatic);
        expect(oracle).toEqual(testCase.expectedOracle);
      }
    });
  }
});
