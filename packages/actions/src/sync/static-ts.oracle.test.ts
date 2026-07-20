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

type CaseMode = "match"; // later tasks add "divergent" | "permissive"

interface OracleCase {
  name: string;
  snippet: string;
  mode: CaseMode;
}

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
  // encoding; rewrite it as the mimic's anyOf-with-null form.
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
    out[key] = normalizeNode(entry);
  }
  return out;
}

const cases: OracleCase[] = [
  {
    name: "object with int/min and optional string",
    snippet: "z.object({ amount: z.number().int().min(1), memo: z.string().optional() })",
    mode: "match",
  },
];

describe("static-ts oracle differential", () => {
  for (const testCase of cases) {
    it(`${testCase.mode}: ${testCase.name}`, async () => {
      const mimic = await staticRead(testCase.snippet);
      const oracle = normalizeOracle(oracleRead(testCase.snippet));
      expect(mimic.recognized).toBe(true);
      expect(mimic.optional).toBe(false);
      expect(mimic.schema).toEqual(oracle);
    });
  }
});
