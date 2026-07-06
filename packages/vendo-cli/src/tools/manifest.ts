/**
 * tools.json contracts — canonical schemas live in @vendoai/core (frozen by the
 * contracts-freeze track, packages/vendo-core/src/manifest). The CLI only
 * re-exports them and owns the deterministic annotation rules extractors share.
 */
import type { ManifestToolAnnotations } from "@vendoai/core";

export {
  toolsManifestSchema,
  manifestToolSchema,
  manifestToolAnnotationsSchema,
  manifestThemeSchema,
  hostEventSchema,
} from "@vendoai/core";
export type { ToolsManifest, ManifestTool, ManifestToolAnnotations, ManifestToolBinding } from "@vendoai/core";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Deterministic safety-annotation rules shared by both extractors — FAIL CLOSED.
 * `mutating`/`dangerous` are REQUIRED by the frozen schema and drive downstream
 * auto-allow, so nothing inferred may relax them:
 *
 * - Route-scan tools are always mutating. Route code can hide side effects
 *   behind GETs, and LLM enrichment must never grant auto-allow.
 * - OpenAPI GET tools are read-only only when their spec operation name is
 *   read-shaped. POST/PUT/PATCH/DELETE tools are always mutating.
 * - DELETE plus destructive action names are dangerous, so write routes never
 *   become auto-allowed.
 */
const DESTRUCTIVE_WORDS = new Set([
  "delete", "remove", "destroy", "cancel", "close", "reset", "revoke", "purge", "wipe", "archive",
  "unpause", "transfer", "send", "invite",
]);
const READ_WORDS = new Set(["get", "list", "fetch", "search", "find", "read", "show", "query", "describe", "count"]);
/** GET names that are safe to auto-allow. Anything else fails closed. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

function hasWord(name: string, allowed: ReadonlySet<string>): boolean {
  return words(name).some((word) => allowed.has(word));
}

export function annotationsFor(
  method: string,
  name: string,
  source: "openapi" | "route-scan",
): ManifestToolAnnotations {
  const m = method.toUpperCase();
  const dangerous = m === "DELETE" || hasWord(name, DESTRUCTIVE_WORDS);
  if (source === "route-scan") {
    const annotations: ManifestToolAnnotations = { mutating: true, dangerous };
    if (m === "PUT" || m === "DELETE") annotations.idempotent = true;
    return annotations;
  }
  if (m === "GET" && hasWord(name, READ_WORDS) && !dangerous) {
    return { mutating: false, dangerous: false };
  }
  const annotations: ManifestToolAnnotations = { mutating: true, dangerous };
  if (m === "PUT" || m === "DELETE") annotations.idempotent = true;
  return annotations;
}
