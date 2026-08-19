import type { ExtractedTool, HttpMethod, PrimitiveToolBinding } from "./formats.js";

/**
 * Tool identity, naming, and protocol-fact risk for HTTP-shaped bindings, kept
 * PURE (no node imports) so both halves of the package can reach it: sync
 * computes identity to diff and dedup, the judgment layer — which lives on the
 * runtime side of the node-only boundary — compares it to decide whether a
 * stored judgment still describes the handler in front of it, and the OpenAPI
 * document extractor names and grades from here for BOTH its callers (the spec
 * file reader in sync, and `openApiConnector` at runtime).
 *
 * `../sync/common.js` re-exports the naming and risk half, so sync's own
 * importers keep their one import site.
 */

export function dedupKey(method: HttpMethod, urlPath: string): string {
  return `${method} ${urlPath.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/g, "") || "/"}`;
}

/** The binding-kind-aware identity a tool is deduplicated and diffed by:
 * method+path for HTTP-shaped bindings, mount+procedure for tRPC (a host can
 * expose the same procedure name under two mounts — both tools must survive),
 * module+export for server actions. */
export function bindingIdentity(binding: PrimitiveToolBinding): string {
  if (binding.kind === "trpc") return `TRPC ${binding.mount.replace(/\/+$/g, "")} ${binding.procedure}`;
  if (binding.kind === "server-action") return `SERVER-ACTION ${binding.module}#${binding.exportName}`;
  return dedupKey(binding.method, binding.path);
}

function routeSegments(urlPath: string): string[] {
  return urlPath.split("/").filter(Boolean);
}

function staticNameParts(urlPath: string): string[] {
  return routeSegments(urlPath)
    .filter((segment, index) => !(index === 0 && segment.toLowerCase() === "api"))
    .filter((segment) => !/^\{[^}]+\}$/.test(segment))
    .flatMap((segment) => segment.match(/[A-Za-z0-9]+/g) ?? [])
    .map((part) => part.toLowerCase());
}

export function routeToolFullName(method: HttpMethod, urlPath: string): string {
  const segments = routeSegments(urlPath);
  const last = segments.at(-1) ?? "";
  const endsInParameter = /^\{[^}]+\}$/.test(last);
  const hasEarlierParameter = segments.slice(0, -1).some((segment) => /^\{[^}]+\}$/.test(segment));
  const parts = staticNameParts(urlPath);
  const stem = `host_${parts.length > 0 ? parts.join("_") : "route"}`;
  if (method === "GET") return `${stem}${endsInParameter ? "_get" : "_list"}`;
  if (method === "POST") return hasEarlierParameter && !endsInParameter ? stem : `${stem}_create`;
  if (method === "PUT" || method === "PATCH") return `${stem}_update`;
  return `${stem}_delete`;
}

export function unclassifiedToolFullName(urlPath: string): string {
  const parts = staticNameParts(urlPath);
  return `host_${parts.length > 0 ? parts.join("_") : "route"}_unclassified`;
}

/**
 * Extraction grades from PROTOCOL FACTS ONLY (risk-grading redesign D2). A
 * tool's NAME never decides anything: English is infinite, so a word list is
 * guaranteed to miss (*pay, charge, refund, approve, merge, publish*) and its
 * existence is what stops a host from auditing the labels.
 *
 * `DELETE` is destructive by definition of the method. Nothing else about an
 * HTTP route is: `GET` alone does not earn `read` (GETs that mutate exist) and
 * `POST` does not earn `write` (search endpoints post). Anything not proven is
 * `ungraded`, which the guard asks about until a human or the judge grades it.
 */
export function extractedRisk(method: HttpMethod): ExtractedTool["risk"] {
  return method === "DELETE" ? "destructive" : "ungraded";
}
