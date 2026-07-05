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
 * - openapi: GET is read-only ONLY when the name is read-shaped; a GET named
 *   like a side effect (connect/poll/dispatch/…) or ambiguously is marked
 *   mutating — HTTP method alone is not evidence (demo-bank's integrations GET
 *   calls connect(), its poll GET fires Slack).
 * - route-scan: EVERY tool is mutating. The surface is LLM-read code; an
 *   LLM judgment must never grant auto-allow. The developer relaxes read-only
 *   tools by hand in the editable tools.json (the init report says so).
 */
const DESTRUCTIVE_NAME = /(^|_)(delete|remove|destroy|cancel|close|reset|revoke|purge|wipe)(_|$)/;
/** GET names that are safe to auto-allow from a spec. Anything else fails closed. */
const READ_NAME = /(^|_)(get|list|fetch|search|find|read|show|query|describe|count)(_|$)/;

export function annotationsFor(
  method: string,
  name: string,
  source: "openapi" | "route-scan",
): ManifestToolAnnotations {
  const m = method.toUpperCase();
  const dangerous = m === "DELETE" || DESTRUCTIVE_NAME.test(name);
  if (m === "GET" && source === "openapi" && READ_NAME.test(name) && !dangerous) {
    return { mutating: false, dangerous: false };
  }
  const annotations: ManifestToolAnnotations = { mutating: true, dangerous };
  if (m === "PUT" || m === "DELETE") annotations.idempotent = true;
  return annotations;
}
