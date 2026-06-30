import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Flowlet contracts type schema fields against the Standard Schema interface
 * (Zod/Valibot/ArkType all implement it). Zod is Flowlet's default impl.
 */
export type FlowletSchema<T> = StandardSchemaV1<T>;

/** True if the schema can be converted to JSON Schema at the LLM/tool boundary. */
export function isJsonSchemaConvertible(schema: unknown): boolean {
  return schema instanceof z.ZodType;
}

/** Convert a boundary schema to JSON Schema. Zod path for now; throws otherwise. */
export function toJsonSchema(schema: unknown): unknown {
  if (schema instanceof z.ZodType) return zodToJsonSchema(schema);
  throw new Error("Schema at the LLM/tool boundary must be JSON-Schema-convertible (use Zod).");
}
