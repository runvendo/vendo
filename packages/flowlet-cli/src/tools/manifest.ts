import { z } from "zod";

/**
 * DRAFT tools.json schema — ENG-197 extractor output.
 *
 * The frozen manifest schema is owned by the contracts-freeze track; this file
 * matches the shapes that already exist in the codebase and must be reconciled
 * when the freeze lands:
 *  - `annotations` mirrors ToolAnnotations (packages/flowlet-agent/src/descriptor.ts,
 *    MCP hint shape). "mutating" == readOnlyHint:false, "dangerous" == destructiveHint:true.
 *  - `events` declares host event types usable as automation triggers
 *    (architecture Decision 3 / Decision 5); the extractor emits [] today.
 * Open questions for the freeze are listed in the ENG-197 fidelity findings doc.
 */

export const toolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

export const httpBindingSchema = z.object({
  method: z.enum(["get", "post", "put", "patch", "delete", "head"]),
  path: z.string().startsWith("/"),
});

export const toolEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case tool names"),
  description: z.string().min(1),
  /** JSON Schema for the tool input (object). Kept opaque here. */
  inputSchema: z.record(z.unknown()),
  annotations: toolAnnotationsSchema,
  http: httpBindingSchema.optional(),
  source: z.enum(["openapi", "route-scan"]),
});

export const hostEventSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export const toolsManifestSchema = z.object({
  version: z.literal(1),
  extractedFrom: z.object({ kind: z.enum(["openapi", "route-scan"]), path: z.string() }).optional(),
  tools: z.array(toolEntrySchema),
  events: z.array(hostEventSchema),
});

export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type ToolEntry = z.infer<typeof toolEntrySchema>;
export type ToolsManifest = z.infer<typeof toolsManifestSchema>;

/** Deterministic annotation rules shared by both extractors. */
export function annotationsFor(method: string, name: string): ToolAnnotations {
  const m = method.toLowerCase();
  const destructiveName = /(^|_)(delete|remove|destroy|cancel|close)(_|$)/.test(name);
  if (m === "get" || m === "head") return { readOnlyHint: true, openWorldHint: false };
  const annotations: ToolAnnotations = { readOnlyHint: false, openWorldHint: false };
  if (m === "put" || m === "delete") annotations.idempotentHint = true;
  if (m === "delete" || destructiveName) annotations.destructiveHint = true;
  return annotations;
}
