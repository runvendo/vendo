import { z } from "zod";
import { manifestThemeSchema } from "./theme";
import { manifestToolSchema } from "./tool";
import { hostEventSchema } from "./event";
import { manifestComponentSchema } from "./component";

/**
 * The `tools.json` FILE as it sits in `.flowlet/` in the host repo:
 * host-API tool descriptors plus declared host event types (Decision 3).
 * Developer-editable after extraction.
 */
export const toolsManifestSchema = z.object({
  version: z.literal(1),
  tools: z.array(manifestToolSchema),
  events: z.array(hostEventSchema).default([]),
});
export type ToolsManifest = z.infer<typeof toolsManifestSchema>;

/**
 * The published manifest — the immutable unit `flowlet publish` uploads to the
 * cloud registry and a session binds to at init (Decision 3). Assembled from
 * the three `.flowlet/` artifacts; the sandbox component bundle travels
 * alongside, referenced by the registry row, not embedded here.
 *
 * Embedded mode reads the same shape directly from `.flowlet/` on disk;
 * publish is a no-op there.
 */
export const flowletManifestSchema = z.object({
  schemaVersion: z.literal(1),
  theme: manifestThemeSchema,
  tools: z.array(manifestToolSchema),
  events: z.array(hostEventSchema),
  components: z.array(manifestComponentSchema),
});
export type FlowletManifest = z.infer<typeof flowletManifestSchema>;

/**
 * Registry identity of a published manifest. Rows are immutable — a re-publish
 * is a new row with an active pointer per environment (Decision 3/6). Sessions
 * carry a ManifestRef, never a mutable manifest.
 */
export interface ManifestRef {
  tenantId: string;
  /** Publisher-supplied version label (e.g. git sha or semver). */
  version: string;
  /** Content hash of the published manifest, assigned by the registry. */
  hash: string;
}
