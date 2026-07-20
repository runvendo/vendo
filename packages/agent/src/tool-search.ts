import {
  VendoError,
  type RiskLabel,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
} from "@vendoai/core";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";

/** The meta-tool the agent uses to discover and load host tools mid-run. */
export const VENDO_TOOLS_SEARCH_TOOL_NAME = "vendo_tools_search";

/** Default bound on the uncurated initial loadout. A large host (dub ≈ 617
 * tools, papermark ≈ 388) would otherwise flood the model's context; the rest
 * stay reachable through {@link VENDO_TOOLS_SEARCH_TOOL_NAME}. */
export const DEFAULT_MAX_INITIAL_TOOLS = 128;

const RISK_ORDER: Record<RiskLabel, number> = { read: 0, write: 1, destructive: 2 };

/** A hit from the injected search seam — the structural twin of actions'
 * `ToolSearchMatch` (the agent block depends on core only, so it cannot import
 * the actions type). */
export interface ToolSearchMatch {
  name: string;
  description: string;
  risk: RiskLabel;
  score: number;
}

/** Ranks the merged, enabled, guard-bound tool surface against a free-text
 * intent. The umbrella wires this to `ActionsRegistry.search`. */
export type ToolSearchFn = (query: string, options?: { limit?: number }) => Promise<ToolSearchMatch[]>;

export interface ToolSearchConfig {
  /** The registry query seam (umbrella wires it to the guard-bound registry). */
  search: ToolSearchFn;
  /** Uncurated loadout cap. Defaults to {@link DEFAULT_MAX_INITIAL_TOOLS}. */
  maxInitialTools?: number;
  /** Explicit curated initial loadout by tool name. When set, exactly these
   *  (that exist and are enabled) start active; the cap is not applied. */
  loadout?: string[];
  /** Per-turn initial-loadout seed (connection-scoped tool loading, spec
   *  2026-07-20): typically the connected toolkits' tools — the umbrella
   *  wires this to registry.loadoutSeed(connectedToolkits). Runs BEFORE the
   *  toolset is built so freshly expanded tools are included. A failure
   *  degrades to the risk/name fallback, never the turn. */
  seed?: (ctx: RunContext) => Promise<string[] | undefined>;
}

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: 25 },
  },
  required: ["query"],
  additionalProperties: false,
} as Parameters<typeof jsonSchema>[0];

/** Vendo's own always-available tools (apps, connect, the meta-tools) are never
 * loadout-gated: they are not host API tools that explode in number, and gating
 * them out would break the product surface. Everything `vendo_`-prefixed stays
 * active; host tools are what the loadout bounds. */
function isAlwaysActive(name: string): boolean {
  return name.startsWith("vendo_");
}

/**
 * The INITIAL enabled set (loadout policy, ENG-252 spec §4):
 *  - Explicit `loadout` present → exactly those names that exist, deduped
 *    (curation, e.g. derived from overrides).
 *  - Otherwise, if the enabled host surface fits the cap → the whole surface.
 *  - Otherwise (uncurated + large) → a deterministic bounded default: safest
 *    risk first (read < write < destructive), then name, capped. The remainder
 *    stays discoverable via search.
 * Vendo's own `vendo_*` tools are always active and excluded from the cap.
 */
export function computeInitialLoadout(
  descriptors: readonly ToolDescriptor[],
  config: ToolSearchConfig,
  seedNames?: readonly string[],
): Set<string> {
  const available = new Set(descriptors.map((descriptor) => descriptor.name));
  const alwaysActive = descriptors.filter((descriptor) => isAlwaysActive(descriptor.name)).map((d) => d.name);
  const hostTools = descriptors.filter((descriptor) => !isAlwaysActive(descriptor.name));

  if (config.loadout !== undefined) {
    return new Set([...alwaysActive, ...config.loadout.filter((name) => available.has(name))]);
  }

  const cap = Math.max(Math.trunc(config.maxInitialTools ?? DEFAULT_MAX_INITIAL_TOOLS), 1);

  // Connection-scoped seed: exactly the relevant tools (host tools + the
  // principal's connected toolkits), capped — never an alphabetical slice.
  if (seedNames !== undefined) {
    const seeded = seedNames.filter((name) => available.has(name) && !isAlwaysActive(name)).slice(0, cap);
    return new Set([...alwaysActive, ...seeded]);
  }
  if (hostTools.length <= cap) return new Set([...alwaysActive, ...hostTools.map((d) => d.name)]);

  const bounded = [...hostTools]
    .sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, cap)
    .map((descriptor) => descriptor.name);
  return new Set([...alwaysActive, ...bounded]);
}

export interface ToolSearchSession {
  /** Names the model may call this step: initial loadout ∪ everything loaded so
   *  far ∪ the always-active `vendo_*` tools (which include this meta-tool). */
  activeToolNames(): string[];
  /** Register `vendo_tools_search` into the run's toolset. */
  attach(tools: ToolSet): void;
}

export interface ToolSearchSessionOptions {
  config: ToolSearchConfig;
  /** The full built toolset's descriptors (names available to load). */
  descriptors: readonly ToolDescriptor[];
  /** Per-run loaded set — persists across turns within a thread. Mutated here. */
  loaded: Set<string>;
  /** Per-turn seed for the initial loadout (see ToolSearchConfig.seed). */
  seedNames?: readonly string[];
  /** Full descriptors for names search returned that are NOT yet in the built
   * toolset — they were lazily expanded during the search itself. */
  resolve?: (names: string[]) => Promise<ToolDescriptor[]>;
  /** Add a freshly resolved descriptor into the LIVE toolset. prepareStep
   * re-reads activeToolNames() each step, so it's callable next step. */
  materialize?: (descriptor: ToolDescriptor) => void;
}

export function createToolSearchSession(options: ToolSearchSessionOptions): ToolSearchSession {
  const available = new Set(options.descriptors.map((descriptor) => descriptor.name));
  const initial = computeInitialLoadout(options.descriptors, options.config, options.seedNames);
  // Captured at attach: the full run toolset. Every Vendo-owned `vendo_*` tool
  // in it stays active regardless of loadout — including the OTHER meta-tools
  // (notably `vendo_report_capability_miss`) that are attached after the host
  // descriptors and so are NOT in `options.descriptors`. Gating them out would
  // silently disable miss capture whenever tool search is on.
  let attached: ToolSet | undefined;

  return {
    activeToolNames() {
      const active = new Set<string>(initial);
      active.add(VENDO_TOOLS_SEARCH_TOOL_NAME);
      for (const name of Object.keys(attached ?? {})) if (isAlwaysActive(name)) active.add(name);
      for (const name of options.loaded) if (available.has(name)) active.add(name);
      return [...active];
    },

    attach(tools) {
      attached = tools;
      if (tools[VENDO_TOOLS_SEARCH_TOOL_NAME] !== undefined) {
        throw new VendoError("conflict", `Reserved internal tool name: ${VENDO_TOOLS_SEARCH_TOOL_NAME}`);
      }
      tools[VENDO_TOOLS_SEARCH_TOOL_NAME] = dynamicTool({
        description:
          "Search ALL of this product's tools and connected-service tools by intent, and LOAD the matches so you can call them this run. "
          + "Results may include tools for services the user has NOT connected yet — calling one is safe and correct: the user is prompted to connect in-line. "
          + "Use this whenever no currently-available tool fits the ask.",
        inputSchema: jsonSchema(SEARCH_INPUT_SCHEMA),
        execute: async (input): Promise<ToolOutcome> => {
          const parsed = input as { query?: unknown; limit?: unknown } | null;
          const query = typeof parsed?.query === "string" ? parsed.query : "";
          if (query.trim().length === 0) {
            return { status: "error", error: { code: "validation", message: "query must be a non-empty string" } };
          }
          const limit = typeof parsed?.limit === "number" ? parsed.limit : undefined;
          let matches: ToolSearchMatch[];
          try {
            matches = await options.config.search(query, limit === undefined ? undefined : { limit });
          } catch {
            return { status: "error", error: { code: "execution", message: "Tool search failed." } };
          }
          // Names outside the built toolset were lazily expanded during this
          // very search — resolve their full descriptors and materialize them
          // into the LIVE toolset so they are callable next step.
          const missing = matches.filter((match) => !available.has(match.name)).map((match) => match.name);
          if (missing.length > 0 && options.resolve !== undefined && options.materialize !== undefined) {
            try {
              for (const descriptor of await options.resolve(missing)) {
                options.materialize(descriptor);
                available.add(descriptor.name);
              }
            } catch {
              // Unresolved names simply stay unloadable below.
            }
          }
          // Only load names that actually exist in this run's guard-bound toolset
          // — a stale or drifting search seam can never conjure an unbound tool.
          const loadable = matches.filter((match) => available.has(match.name));
          for (const match of loadable) options.loaded.add(match.name);
          return {
            status: "ok",
            output: {
              loaded: loadable.map((match) => match.name),
              tools: loadable.map((match) => ({ name: match.name, description: match.description, risk: match.risk })),
            },
          };
        },
      });
    },
  };
}
