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
 * Result-field format vocabulary (data-fidelity hardening): a manifest tool may
 * declare how its RESULT fields are encoded so the prompt layer can render
 * explicit formatting rules ("amount is integer cents: divide by 100") instead
 * of letting the model guess a divisor or timezone-shift a date. Closed enum
 * on purpose — every value maps to one vetted instruction in
 * `prompt/format-hints.ts`; extending it means writing the instruction too.
 */
export const manifestFieldFormatSchema = z.enum([
  "cents",
  "iso-date",
  "iso-datetime",
  "percent",
]);
export type FieldFormat = z.infer<typeof manifestFieldFormatSchema>;

/** Field name → format. Keys are RESULT field names (any depth — hints are
 *  prose for the model, so JSON-pointer precision buys nothing).
 *
 *  Keys are constrained to the same identifier charset as tool names: they
 *  are interpolated into the prompt by `prompt/format-hints.ts`, so a
 *  free-form key (quotes, newlines) would be a prompt-injection surface.
 *  The renderer ALSO escapes defensively — but the manifest contract fails
 *  closed here, at validation time. */
export const manifestToolFormatsSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  manifestFieldFormatSchema,
);

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
     *  with a single `/` (no scheme, no `//authority`), contain no whitespace,
     *  and contain no backslash — browsers normalize `\`→`/`, so `/\evil.com`
     *  would otherwise become a cross-origin URL. `[^\s\\]` keeps this a plain
     *  regex `pattern` in the generated JSON Schema while rejecting exactly the
     *  paths the runtime executor's `isHostRelativePath` guard rejects. */
    path: z.string().regex(/^\/(?!\/)[^\s\\]*$/),
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
    /** OPTIONAL and additive (no default): result-field format hints. Old
     *  manifests without it stay valid byte-for-byte. */
    formats: manifestToolFormatsSchema.optional(),
  })
  .strict();
export type ManifestTool = z.infer<typeof manifestToolSchema>;
