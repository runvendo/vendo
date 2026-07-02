import { z } from "zod";
import { jsonSchemaDocument } from "./tool";

/**
 * A host event type declared in `tools.json`, available as an automation
 * trigger (architecture Decisions 3 & 5). At runtime the host backend delivers
 * instances as signed webhooks to the cloud worker; embedded hosts may invoke
 * the ingest path in-process. Names are dot-namespaced, lower_snake segments:
 * `invoice.paid`, `user.plan_changed`.
 */
export const hostEventSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /** Drives trigger selection when the compiler agent builds an automation. */
  description: z.string().min(1),
  /** JSON Schema for the event payload; omitted = opaque payload. */
  payloadSchema: jsonSchemaDocument.optional(),
});
export type HostEventDeclaration = z.infer<typeof hostEventSchema>;
