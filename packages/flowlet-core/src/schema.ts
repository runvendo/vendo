import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Flowlet contracts type schema fields against the Standard Schema interface
 * (Zod/Valibot/ArkType all implement it). Zod is Flowlet's default impl.
 */
export type FlowletSchema<T> = StandardSchemaV1<T>;

/**
 * A schema usable at the LLM/tool boundary: either a Standard Schema (Zod) the
 * runtime can validate against, or a pre-converted JSON Schema (e.g. from an MCP tool).
 */
export type BoundarySchema<T> = FlowletSchema<T> | { jsonSchema: unknown };

function isJsonSchemaWrapper(schema: unknown): schema is { jsonSchema: unknown } {
  return typeof schema === "object" && schema !== null && "jsonSchema" in schema;
}

/** True if the schema can be converted to JSON Schema at the LLM/tool boundary. */
export function isJsonSchemaConvertible(schema: unknown): boolean {
  return schema instanceof z.ZodType || isJsonSchemaWrapper(schema);
}

/** Convert a boundary schema to JSON Schema. */
export function toJsonSchema(schema: unknown): unknown {
  if (isJsonSchemaWrapper(schema)) return schema.jsonSchema;
  if (schema instanceof z.ZodType) return zodToJsonSchema(schema);
  throw new Error("Schema at the LLM/tool boundary must be JSON-Schema-convertible (use Zod).");
}
