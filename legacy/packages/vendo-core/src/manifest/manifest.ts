import { z } from "zod";
import { manifestThemeSchema } from "./theme.js";
import { manifestToolSchema } from "./tool.js";
import { hostEventSchema } from "./event.js";
import { manifestComponentSchema } from "./component.js";

/**
 * The `tools.json` FILE as it sits in `.vendo/` in the host repo:
 * host-API tool descriptors plus declared host event types (Decision 3).
 * Developer-editable after extraction.
 */
export const toolsManifestSchema = z
  .object({
    version: z.literal(1),
    tools: z.array(manifestToolSchema),
    /** Optional in the file; zod parse normalizes a missing `events` to `[]`.
     *  JSON Schema `default` is annotation-only, so raw-JSON consumers must
     *  treat a missing `events` as empty themselves. */
    events: z.array(hostEventSchema).default([]),
  })
  .strict();
export type ToolsManifest = z.infer<typeof toolsManifestSchema>;

/**
 * The published manifest — the immutable unit `vendo publish` uploads to the
 * cloud registry and a session binds to at init (Decision 3). Assembled from
 * the three `.vendo/` artifacts; the sandbox component bundle travels
 * alongside, referenced by the registry row, not embedded here.
 *
 * Embedded mode reads the same shape directly from `.vendo/` on disk;
 * publish is a no-op there.
 */
export const vendoManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    theme: manifestThemeSchema,
    tools: z.array(manifestToolSchema),
    events: z.array(hostEventSchema),
    components: z.array(manifestComponentSchema),
  })
  .strict();
export type VendoManifest = z.infer<typeof vendoManifestSchema>;

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
