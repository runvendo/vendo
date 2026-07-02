/**
 * tools.json contracts — canonical schemas live in @flowlet/core (frozen by the
 * contracts-freeze track, packages/flowlet-core/src/manifest). The CLI only
 * re-exports them and owns the deterministic annotation rules extractors share.
 */
import type { ManifestToolAnnotations } from "@flowlet/core";

export {
  toolsManifestSchema,
  manifestToolSchema,
  manifestToolAnnotationsSchema,
  manifestThemeSchema,
  hostEventSchema,
} from "@flowlet/core";
export type { ToolsManifest, ManifestTool, ManifestToolAnnotations, ManifestToolBinding } from "@flowlet/core";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Deterministic safety-annotation rules shared by both extractors.
 * `mutating`/`dangerous` are REQUIRED by the frozen schema; policy fails closed
 * on anything write-shaped, so extraction errs on the safe side: every DELETE
 * and every destructive-sounding name is dangerous (approval-gated) until the
 * developer edits tools.json.
 */
export function annotationsFor(method: string, name: string): ManifestToolAnnotations {
  const m = method.toUpperCase();
  const destructiveName = /(^|_)(delete|remove|destroy|cancel|close)(_|$)/.test(name);
  if (m === "GET") return { mutating: false, dangerous: false };
  const annotations: ManifestToolAnnotations = {
    mutating: true,
    dangerous: m === "DELETE" || destructiveName,
  };
  if (m === "PUT" || m === "DELETE") annotations.idempotent = true;
  return annotations;
}
