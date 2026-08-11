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
 *  reachable through {@link FIND_TOOLS_TOOL_NAME} instead of flooding context. */
export const DEFAULT_MAX_INITIAL_TOOLS = 128;

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
 * Deterministic keyword scoring over the turn's own listings — the fallback
 * when no registry search seam is configured, and the backstop when the seam
 * throws. Same weights as the actions scorer (`actions/runtime/search.ts`), so
 * the two rank alike on the surface they share.
 */
export function searchListings(
  listings: readonly ToolListing[],
  query: string,
  limit = 10,
): { name: string; description: string; score: number }[] {
  const seen = new Set<string>();
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !seen.has(token) && (seen.add(token), true));
  if (tokens.length === 0) return [];
  const collapsed = query.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const hits = listings.flatMap((listing) => {
    const name = listing.name.toLowerCase();
    const nameTokens = new Set(name.split(/[^a-z0-9]+/));
    const description = listing.description.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (nameTokens.has(token)) score += 8;
      else if (name.includes(token)) score += 4;
      if (description.includes(token)) score += 2;
    }
    if (collapsed.length > 0 && name.replace(/[^a-z0-9]+/g, "").includes(collapsed)) score += 5;
    return score > 0 ? [{ name: listing.name, description: listing.description, score }] : [];
  });
  hits.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : 1));
  return hits.slice(0, bounded);
}

export const FIND_TOOLS_DESCRIPTION =
  "Search this product's tools by intent and LOAD the matches so you can call them this run. "
  + "Use this only when no currently-available tool fits the ask — never to browse or enumerate. "
  + "A match from a service the user has not connected will answer with a connect card when "
  + "called; ask for the service with request_connection instead of retrying its tools.";
