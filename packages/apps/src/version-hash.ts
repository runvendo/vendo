import { canonicalJson, sha256Hex, type AppDocument } from "@vendoai/core";

/**
 * Hash the execution-bearing content of an app version for in-client approval.
 * `id` and `forkedFrom` are copy identity/provenance, not content: import mints a
 * fresh id and intentionally drops lineage. All other fields, including the
 * server snapshot reference, affect what the approved app can render or do.
 */
export const appVersionHash = (doc: AppDocument): string => {
  const { id: _id, forkedFrom: _forkedFrom, ...content } = structuredClone(doc);
  return `sha256:${sha256Hex(canonicalJson(content))}`;
};
