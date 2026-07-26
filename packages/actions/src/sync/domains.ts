/**
 * Domain-manifest derivation (W3, folded into the sync engine for format v3):
 * the `has` list of `.vendo/tools.json`'s `domains` is derived from tool
 * names on FIRST sync and host-owned afterwards (authored additions live in
 * `.vendo/overrides.json` `domains` and union in at read time).
 */

/** Verb tokens dropped from a tool name when deriving its data domain. */
const NAME_VERBS = /^(get|list|create|update|delete|set|send|reset|simulate|search|fetch|read|add|remove|post|put|patch)$/i;
/** Whole tools that are plumbing, not a data domain. */
const NOISE_TOKENS = /^(auth|demo|voice|session|sessions|webhook|webhooks|health|ping)$/i;

/** host_listAccountTransactions → "account transactions". */
export const domainFromToolName = (name: string): string | undefined => {
  const tokens = name
    .replace(/^host_/, "")
    .split(/[_.]/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.some((token) => NOISE_TOKENS.test(token))) return undefined;
  const nouns = tokens.filter((token) => !NAME_VERBS.test(token));
  if (nouns.length === 0) return undefined;
  return nouns.join(" ");
};

export const deriveDomains = (toolNames: readonly string[]): string[] =>
  [...new Set(toolNames.map(domainFromToolName).filter((domain): domain is string => domain !== undefined))].sort();
