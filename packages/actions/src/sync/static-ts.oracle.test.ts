import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  loadTypescript,
  localInitializer,
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

type CaseMode = "match" | "divergent"; // a later task adds "permissive"

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

type OracleCase = MatchCase | DivergentCase;

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
  { name: "record (untyped value)", snippet: "z.record(z.any())", mode: "match" },
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
];

describe("static-ts oracle differential", () => {
  for (const testCase of cases) {
    it(`${testCase.mode}: ${testCase.name}`, async () => {
      const mimic = await staticRead(testCase.snippet);
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
