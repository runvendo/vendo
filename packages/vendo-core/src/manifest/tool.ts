import { z } from "zod";

/**
 * A JSON Schema document, kept opaque. Tool inputs and event payloads are
 * declared as JSON Schema in the manifest (the wire format); zod is the
 * in-process representation and the ai SDK converts at the model boundary.
 *
 * Deliberately NOT meta-schema-validated here: the registry validates nested
 * documents against the JSON Schema meta-schema at publish time (ENG-197/198),
 * where a real validator is already loaded. The contract keeps them opaque.
 */
export const jsonSchemaDocument = z.record(z.unknown());
export type JsonSchemaDocument = Record<string, unknown>;

/**
 * Safety annotations, REQUIRED on every manifest tool (architecture Decision 3).
 * Policy reads definite values — a tool with unknown safety cannot be published.
 *
 * MCP mapping (for ingestion into runtime tool descriptors):
 * `readOnlyHint = !mutating`, `destructiveHint = dangerous`,
 * `idempotentHint = idempotent`.
 */
export const manifestToolAnnotationsSchema = z
  .object({
    /** Writes host state. `false` = safe to call freely (read-only). */
    mutating: z.boolean(),
    /** Danger-gated: policy emits an approval card (interactive) or requires
     *  pre-authorized scopes / async approval (automations). */
    dangerous: z.boolean(),
    /** Optional: repeat calls with the same input are safe. */
    idempotent: z.boolean().optional(),
  })
  .strict();
export type ManifestToolAnnotations = z.infer<typeof manifestToolAnnotationsSchema>;

/**
 * How a tool call physically reaches the host API. `http` is the only binding
 * frozen now; the discriminated union is the extension point (trpc, graphql —
 * ENG-197 extractor targets). Path segments in `{braces}` are template
 * parameters filled from the tool input by name.
 */
export const httpBindingSchema = z
  .object({
    type: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** Host-relative path template, e.g. `/api/invoices/{id}/cancel`. Must start
     *  with a single `/` (no scheme, no `//authority`) and contain no whitespace —
     *  a manifest path can never point a client executor at a foreign origin. */
    path: z.string().regex(/^\/(?!\/)\S*$/),
  })
  .strict();
export const manifestToolBindingSchema = z.discriminatedUnion("type", [httpBindingSchema]);
export type ManifestToolBinding = z.infer<typeof manifestToolBindingSchema>;

/**
 * One entry in `tools.json` (dev-tool artifact 3 of 3, architecture Decision 3):
 * a host-API surface exposed to the agent as a tool. Developer-editable;
 * `vendo publish` validates against this schema before upload.
 */
export const manifestToolSchema = z
  .object({
    /** Tool-call identifier presented to the model. */
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    /** Drives LLM tool selection — same role as component descriptions. */
    description: z.string().min(1),
    /** JSON Schema for the tool input. */
    inputSchema: jsonSchemaDocument,
    annotations: manifestToolAnnotationsSchema,
    binding: manifestToolBindingSchema,
  })
  .strict();
export type ManifestTool = z.infer<typeof manifestToolSchema>;
