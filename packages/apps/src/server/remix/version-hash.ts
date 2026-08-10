import {
  canonicalJson,
  sha256Hex,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";

/**
 * Hash the execution-bearing content of an app version for in-client approval.
 * `id` and `forkedFrom` are copy identity/provenance, not content: import mints a
 * fresh id and intentionally drops lineage. `session` is the brain's
 * conversation — it records what was SAID, and saying something changes nothing
 * the approved app can render or do, so counting it would drop a reviewer's
 * approval on every turn of chat. All other fields, including the server
 * snapshot reference, affect what the approved app can render or do.
 */
export const appVersionHash = (doc: AppDocument): string => {
  const { id: _id, forkedFrom: _forkedFrom, ...content } = structuredClone(doc) as AppDocument & { session?: unknown };
  delete content.session;
  return `sha256:${sha256Hex(canonicalJson(content))}`;
};
