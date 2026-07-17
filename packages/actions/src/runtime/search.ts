import type { RiskLabel, ToolDescriptor } from "@vendoai/core";

/** A ranked hit from {@link searchToolDescriptors}. Carries just enough to load
 * the tool into a run and describe it to the model — never the input schema. */
export interface ToolSearchMatch {
  name: string;
  description: string;
  risk: RiskLabel;
  /** Deterministic relevance score; higher is a stronger match. Always > 0. */
  score: number;
}

export interface ToolSearchOptions {
  /** Max matches returned. Defaults to 10; clamped to [1, 50]. */
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const EXACT_NAME_TOKEN = 8;
const NAME_SUBSTRING = 4;
const DESCRIPTION_MATCH = 2;
const WHOLE_QUERY_IN_NAME = 5;

/** Lowercase alphanumeric tokens, de-duplicated, order-preserving. */
function tokenize(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0 || seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(raw);
  }
  return tokens;
}

function scoreDescriptor(descriptor: ToolDescriptor, queryTokens: string[], collapsedQuery: string): number {
  const name = descriptor.name.toLowerCase();
  const nameTokens = new Set(tokenize(descriptor.name));
  const description = descriptor.description.toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += EXACT_NAME_TOKEN;
    else if (name.includes(token)) score += NAME_SUBSTRING;
    if (description.includes(token)) score += DESCRIPTION_MATCH;
  }

  // A contiguous run of the whole query inside the name (ignoring separators) is
  // a strong signal, e.g. "createinvoice" matching host_create_invoice.
  if (collapsedQuery.length > 0 && name.replace(/[^a-z0-9]+/g, "").includes(collapsedQuery)) {
    score += WHOLE_QUERY_IN_NAME;
  }

  return score;
}

/**
 * Pure, deterministic ranking of tool descriptors against a free-text intent.
 *
 * Callers pass the ALREADY-enabled descriptor set (disabled tools excluded
 * upstream), so a disabled tool is never returned as a loadable match. Ties
 * break by name ascending; the result is stable for a given input.
 */
export function searchToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  query: string,
  options?: ToolSearchOptions,
): ToolSearchMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const collapsedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const limit = Math.min(Math.max(Math.trunc(options?.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

  const matches: ToolSearchMatch[] = [];
  for (const descriptor of descriptors) {
    const score = scoreDescriptor(descriptor, queryTokens, collapsedQuery);
    if (score <= 0) continue;
    matches.push({ name: descriptor.name, description: descriptor.description, risk: descriptor.risk, score });
  }

  matches.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return matches.slice(0, limit);
}
