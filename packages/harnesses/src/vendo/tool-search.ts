/**
 * vendo()'s tool-search strategy — the loadout cap and the `find_tools` hand.
 *
 * Brain strategy, not runtime machinery: `claudeCode()` reads a large catalog
 * natively and opted out of curation entirely; this file is how OUR brain copes
 * with a 600-tool host (dub ≈ 617, papermark ≈ 388). It lives in the vendo
 * folder because it is vendo()'s coping strategy and nobody else's — the
 * runtime's ctx safety projection (what may be offered AT ALL) is unrelated
 * machinery and stays in `turn-tools.ts`.
 *
 * No session object, no ToolSet attach, no adapter dance: `vendo()` mounts
 * `find_tools` as one of its own hands, scores over the turn's own listings
 * (or a composed registry search), and remembers what it loaded in
 * `turn.state` — the brain's own memory slot.
 */
import type { ToolListing } from "@vendoai/core";
import { CAPABILITY_MISS_TOOL_NAME } from "../capability-miss.js";

export const FIND_TOOLS_TOOL_NAME = "find_tools";

/** Bound on the uncurated initial loadout: past it, the rest of the catalog is
 *  reachable through {@link FIND_TOOLS_TOOL_NAME} instead of flooding context.
 *
 *  24, not 128 (2026-08-11): selection accuracy degrades past 30-50 offered
 *  tools (Anthropic's tool-search numbers: deferring the catalog behind search
 *  raised Opus 4.5 tool-selection from 79.5% to 88.1%; OpenAI's guidance says
 *  under ~20 upfront). The always-active set rides on top, so the belt lands
 *  right at the edge of the safe band — and the belt is a convenience, never
 *  the contract: everything past it is one search away. */
export const DEFAULT_MAX_INITIAL_TOOLS = 24;

/**
 * What composition (or a host) hands `vendo()` at construction. All optional —
 * `search` unset falls back to {@link searchListings} over the turn's own
 * listings, so a bare config still gets a working `find_tools`.
 */
export interface VendoToolSearchConfig {
  /** Registry-backed search (the umbrella wires `ActionsRegistry.search`, which
   *  may lazily expand a connector toolkit — the expanded tools then join the
   *  projected listing, which vendo() re-reads after every call). */
  search?: (query: string, options?: { limit?: number }) =>
    Promise<readonly { name: string; description: string; score: number }[]>;
  /** Uncurated loadout cap; defaults to {@link DEFAULT_MAX_INITIAL_TOOLS}. */
  maxInitialTools?: number;
  /** Explicit curated starting set. When set, exactly these (that exist) start
   *  active and the cap is not applied. */
  loadout?: string[];
  /** Names never hidden behind the cap. The COMPOSITION declares the tools its
   *  prompt teaches by name (uiaudit 2026-08-06 — a host past the cap lost
   *  `request_connection` while the prompt kept teaching it); the harness
   *  itself exempts only its own capability-miss hand. */
  alwaysActive?: readonly string[];
}

/** The harness's ONE native exemption: its own capability-miss listing. Every
 *  product name is the composition's to declare through
 *  {@link VendoToolSearchConfig.alwaysActive} — this file knows no product
 *  tools. */
export const alwaysActivePredicate = (
  config: VendoToolSearchConfig = {},
): ((name: string) => boolean) => {
  const names = new Set<string>([CAPABILITY_MISS_TOOL_NAME, ...(config.alwaysActive ?? [])]);
  return (name: string): boolean => names.has(name);
};

/** Safest first, ungraded last — an uncapped tool nobody has graded is the
 *  weakest claim on the budget. */
const RISK_ORDER: Record<string, number> = { read: 0, write: 1, destructive: 2, ungraded: 3 };

/**
 * The starting toolbelt: an explicit `loadout` wins; a surface under the cap
 * rides whole; a large one is cut safest-first (read < write < destructive),
 * then A-Z — deterministic, never an alphabetical accident.
 */
export function computeInitialLoadout(
  listings: readonly ToolListing[],
  config: VendoToolSearchConfig,
): Set<string> {
  const isAlwaysActive = alwaysActivePredicate(config);
  const always = listings.filter((listing) => isAlwaysActive(listing.name)).map((l) => l.name);
  const host = listings.filter((listing) => !isAlwaysActive(listing.name));
  if (config.loadout !== undefined) {
    const available = new Set(host.map((listing) => listing.name));
    return new Set([...always, ...config.loadout.filter((name) => available.has(name))]);
  }
  const cap = Math.max(Math.trunc(config.maxInitialTools ?? DEFAULT_MAX_INITIAL_TOOLS), 1);
  if (host.length <= cap) return new Set([...always, ...host.map((listing) => listing.name)]);
  const bounded = [...host]
    .sort((a, b) => ((RISK_ORDER[a.risk] ?? 3) - (RISK_ORDER[b.risk] ?? 3))
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, cap);
  return new Set([...always, ...bounded.map((listing) => listing.name)]);
}

/**
 * Deterministic lexical scoring over the turn's own listings — the fallback
 * when no registry search seam is configured, and the backstop when the seam
 * throws.
 *
 * Ported from executor (`UsefulSoftwareCo/executor`,
 * `packages/core/execution/src/tool-invoker.ts`, MIT © 2026 Rhys Sullivan):
 * the normalize/tokenize pipeline, the per-field bonus tiers (exact ×14,
 * prefix ×9, phrase ×6, exact token ×4, prefix token ×2, substring ×1), the
 * token-coverage gate, and the coverage/first-token/verbatim bonuses. Two
 * fields instead of their four: a `ToolListing` carries no path or
 * integration — the NAME holds the prefix (`vendo_apps_pin`,
 * `GITHUB_CREATE_ISSUE`), and the tokenizer's camelCase/underscore splitting
 * is what lets one field do both jobs. The coverage gate is the part the old
 * substring scorer lacked: a query half-matched everywhere no longer fakes
 * relevance, because a candidate must cover every token of a short query
 * (≥60% of a long one) or match the exact phrase to rank at all.
 */
const SEARCH_FIELD_WEIGHTS = { name: 10, description: 5 } as const;

const normalizeSearchText = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim();

const tokenizeSearchText = (value: string): string[] =>
  normalizeSearchText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

interface PreparedField {
  readonly raw: string;
  readonly tokens: readonly string[];
}

const prepareField = (value?: string): PreparedField => ({
  raw: normalizeSearchText(value ?? ""),
  tokens: tokenizeSearchText(value ?? ""),
});

function scorePreparedField(
  query: string,
  queryTokens: readonly string[],
  field: PreparedField,
  weight: number,
): { score: number; matchedTokens: ReadonlySet<string>; exactPhraseMatch: boolean } {
  if (field.raw.length === 0) return { score: 0, matchedTokens: new Set<string>(), exactPhraseMatch: false };
  let score = 0;
  const matchedTokens = new Set<string>();
  const exactPhraseMatch = query.length > 0 && field.raw.includes(query);
  if (query.length > 0) {
    if (field.raw === query) score += weight * 14;
    else if (field.raw.startsWith(query)) score += weight * 9;
    else if (exactPhraseMatch) score += weight * 6;
  }
  for (const token of queryTokens) {
    if (field.tokens.includes(token)) {
      score += weight * 4;
      matchedTokens.add(token);
      continue;
    }
    if (field.tokens.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))) {
      score += weight * 2;
      matchedTokens.add(token);
      continue;
    }
    if (field.raw.includes(token)) {
      score += weight;
      matchedTokens.add(token);
    }
  }
  return { score, matchedTokens, exactPhraseMatch };
}

function scoreListing(
  listing: ToolListing,
  query: string,
  queryTokens: readonly string[],
): { name: string; description: string; score: number } | null {
  const name = prepareField(listing.name);
  const description = prepareField(listing.description);
  const fieldScores = [
    scorePreparedField(query, queryTokens, name, SEARCH_FIELD_WEIGHTS.name),
    scorePreparedField(query, queryTokens, description, SEARCH_FIELD_WEIGHTS.description),
  ];
  const matchedTokens = new Set<string>();
  let score = 0;
  let exactPhraseMatch = false;
  for (const fieldScore of fieldScores) {
    score += fieldScore.score;
    exactPhraseMatch ||= fieldScore.exactPhraseMatch;
    for (const token of fieldScore.matchedTokens) matchedTokens.add(token);
  }
  if (matchedTokens.size === 0) return null;
  const coverage = matchedTokens.size / queryTokens.length;
  if (coverage < (queryTokens.length <= 2 ? 1 : 0.6) && !exactPhraseMatch) return null;
  score += coverage === 1 ? 25 : Math.round(coverage * 10);
  if (name.tokens[0] === queryTokens[0]) score += 8;
  if (name.raw === query) score += 20;
  return { name: listing.name, description: listing.description, score };
}

export function searchListings(
  listings: readonly ToolListing[],
  query: string,
  limit = 10,
): { name: string; description: string; score: number }[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);
  if (normalizedQuery.length === 0 || queryTokens.length === 0) return [];
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const hits = listings.flatMap((listing) => {
    const hit = scoreListing(listing, normalizedQuery, queryTokens);
    return hit === null ? [] : [hit];
  });
  hits.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : 1));
  return hits.slice(0, bounded);
}

export const FIND_TOOLS_DESCRIPTION =
  "Search this product's full tool catalog by what you need to do and LOAD the matches so you "
  + "can call them this run. Your equipped tools are a working set, not the limit — search "
  + "whenever the ask might be served by a tool you don't see, and try a second phrasing before "
  + "concluding a capability doesn't exist. Never use it to browse or enumerate. "
  + "A match from a service the user has not connected will answer with a connect card when "
  + "called; ask for the service with request_connection instead of retrying its tools.";
