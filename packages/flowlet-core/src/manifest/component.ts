import { z } from "zod";
import { jsonSchemaDocument } from "./tool";

/**
 * The published image of one entry in `.flowlet/components/` (dev-tool artifact
 * 2 of 3). On disk each entry is a descriptor + wrapper pair compiled into the
 * sandbox bundle; the published manifest carries only the descriptor, with the
 * props schema serialized to JSON Schema. This is the JSON form of
 * `RegisteredComponent` / `PrewiredDescriptor` (name, description, propsSchema).
 */
export const manifestComponentSchema = z
  .object({
    name: z.string().min(1),
    /** Drives LLM component selection — same field as `RegisteredComponent.description`. */
    description: z.string().min(1),
    /** JSON Schema for the component props (zod-serialized at publish time). */
    propsSchema: jsonSchemaDocument,
  })
  .strict();
export type ManifestComponent = z.infer<typeof manifestComponentSchema>;
