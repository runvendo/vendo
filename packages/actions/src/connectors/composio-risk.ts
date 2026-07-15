import type { RiskLabel } from "@vendoai/core";

/** Verbs whose presence ANYWHERE in a slug marks the tool destructive. A tool
 * that touches deletion at all (even "GET_DELETED_X") asks conservatively —
 * a false "destructive" costs one extra approval; a false "read" skips the
 * forced-ask gate on a real deletion. */
const DESTRUCTIVE_TOKENS = new Set([
  "DELETE",
  "DELETED",
  "REMOVE",
  "DESTROY",
  "PURGE",
  "DROP",
  "ERASE",
  "WIPE",
  "TRUNCATE",
  "TERMINATE",
  "REVOKE",
  "UNINSTALL",
  "DEPROVISION",
  "KILL",
  "BAN",
]);

/** Verbs that mark a tool read-only ONLY in the leading (verb) position —
 * "SEND_LIST_SUBSCRIPTION" must stay write. */
const READ_VERBS = new Set([
  "GET",
  "LIST",
  "FETCH",
  "SEARCH",
  "FIND",
  "READ",
  "RETRIEVE",
  "LOOKUP",
  "QUERY",
  "COUNT",
  "DESCRIBE",
  "CHECK",
  "VIEW",
  "SHOW",
]);

/** 04-actions §3 — curated Composio risk resolution, replacing the old
 * hardcoded `risk:"write"`:
 *   1. Composio metadata where available: `destructiveHint`/`readOnlyHint`
 *      tool tags (destructive beats a stale read-only hint);
 *   2. curated slug patterns (destructive tokens anywhere; read verbs leading);
 *   3. conservative `write` default.
 * overrides.json still wins downstream via the registry's mergeOverride. */
export function composioToolRisk(rawSlug: string, toolkit: string, tags?: string[]): RiskLabel {
  const tokens = rawSlug.toUpperCase().split("_").filter(Boolean);
  const toolkitTokens = toolkit.toUpperCase().split("_").filter(Boolean);
  // Strip the toolkit prefix so the leading token is the verb.
  let start = 0;
  while (start < toolkitTokens.length && tokens[start] === toolkitTokens[start]) start += 1;
  const verbTokens = tokens.slice(start);

  const destructiveBySlug = verbTokens.some((token) => DESTRUCTIVE_TOKENS.has(token));
  if (tags?.includes("destructiveHint") === true || destructiveBySlug) return "destructive";
  if (tags?.includes("readOnlyHint") === true) return "read";
  if (verbTokens.length > 0 && READ_VERBS.has(verbTokens[0]!)) return "read";
  return "write";
}
