import {
  VendoError,
  type RiskLabel,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
} from "@vendoai/core";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";

/** The meta-tool the agent uses to discover and load host tools mid-run.
 *
 *  Named `find_tools` (design §4). Note it does NOT carry the `vendo_` prefix
 *  that `isAlwaysActive` below exempts — it stays active because
 *  `activeToolNames` adds it explicitly, which is asserted in the tests so the
 *  two rules cannot drift into disabling discovery. */
export const FIND_TOOLS_TOOL_NAME = "find_tools";

/** Default bound on the uncurated initial loadout. A large host (dub ≈ 617
 * tools, papermark ≈ 388) would otherwise flood the model's context; the rest
 * stay reachable through {@link FIND_TOOLS_TOOL_NAME}. */
export const DEFAULT_MAX_INITIAL_TOOLS = 128;

/** Seed order for the capped loadout: safest first, ungraded last — an
 *  uncapped tool nobody has graded is the weakest claim on the budget. */
const RISK_ORDER: Record<RiskLabel, number> = { read: 0, write: 1, destructive: 2, ungraded: 3 };

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
 * intent. The umbrella wires this to `ActionsRegistry.search`.
 *
 * `ctx` is the CALLER's, handed down from the run — a search may EXPAND a lazy
 * connector toolkit, and that expansion belongs to the conversation that asked
 * for it rather than to every later listing in the process. Without it the
 * matches can name tools this run's own listing will not contain. */
export type ToolSearchFn = (
  query: string,
  options?: { limit?: number },
  ctx?: RunContext,
) => Promise<ToolSearchMatch[]>;

export interface ToolSearchConfig {
  /** The registry query seam (umbrella wires it to the guard-bound registry). */
  search: ToolSearchFn;
  /** Whether this subject still has to connect an account before a toolkit's
   *  tools can run. Used to ANNOTATE search results, which the tool description
   *  and the system prompt both promise and the connect-card flow depends on.
   *  Unwired = no annotation (and nothing claims otherwise). */
  connectRequired?: (toolkit: string, ctx: RunContext) => Promise<boolean>;
  /** Uncurated loadout cap. Defaults to {@link DEFAULT_MAX_INITIAL_TOOLS}. */
  maxInitialTools?: number;
  /** Explicit curated initial loadout by tool name. When set, exactly these
   *  (that exist and are enabled) start active; the cap is not applied. */
  loadout?: string[];
  /** Per-turn initial-loadout seed — the umbrella wires this to
   *  `registry.loadoutSeed()`, every tool the registry has loaded. Resolved per
   *  turn rather than once, because `add()` can register a source after boot. A
   *  failure degrades to the risk/name fallback, never the turn. */
  seed?: (ctx: RunContext) => Promise<string[] | undefined>;
  /** The host's curated menu for THIS surface (`surfaces.agent` in
   *  `.vendo/overrides.json`, resolved by the umbrella). `undefined` means
   *  unrestricted. It binds every path into the initial loadout — including an
   *  explicit `loadout`, which is host config but not a licence to offer a tool
   *  the host curated off this surface. Vendo's own `vendo_*` tools are never
   *  filtered by it. Resolved per turn, beside `seed`. */
  menu?: (ctx: RunContext) => Promise<readonly string[] | undefined>;
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

/** Does the surface menu offer this name? ONE definition, used by both the
 *  initial loadout and the per-step re-add of the persisted loaded set, so the
 *  two can never drift apart on the exemption rules. `undefined` menu =
 *  unrestricted; Vendo's own `vendo_*` tools are always offered. */
function offeredByMenu(menu: Set<string> | undefined, name: string): boolean {
  return menu === undefined || isAlwaysActive(name) || menu.has(name);
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
  /** The resolved surface menu (see ToolSearchConfig.menu). */
  menuNames?: readonly string[],
): Set<string> {
  // The menu binds EVERY branch below. It is applied here, once, rather than at
  // each branch, so no future loadout path can quietly escape it.
  const menu = menuNames === undefined ? undefined : new Set(menuNames);
  const offered = (name: string): boolean => offeredByMenu(menu, name);
  const available = new Set(descriptors.filter((d) => offered(d.name)).map((descriptor) => descriptor.name));
  const alwaysActive = descriptors.filter((descriptor) => isAlwaysActive(descriptor.name)).map((d) => d.name);
  const hostTools = descriptors.filter((descriptor) => !isAlwaysActive(descriptor.name) && offered(descriptor.name));

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
  /** Register `find_tools` into the run's toolset. */
  attach(tools: ToolSet): void;
}

export interface ToolSearchSessionOptions {
  config: ToolSearchConfig;
  /** This turn's context. Used to annotate search results connect-required for
   *  THIS subject (a connection is per person, not per deployment). */
  ctx?: RunContext;
  /** The full built toolset's descriptors (names available to load). */
  descriptors: readonly ToolDescriptor[];
  /** Per-run loaded set — persists across turns within a thread. Mutated here. */
  loaded: Set<string>;
  /** Per-turn seed for the initial loadout (see ToolSearchConfig.seed). */
  seedNames?: readonly string[];
  /** Per-turn resolved surface menu (see ToolSearchConfig.menu). */
  menuNames?: readonly string[];
  /** Full descriptors for names search returned that are NOT yet in the built
   * toolset — they were lazily expanded during the search itself. */
  resolve?: (names: string[]) => Promise<ToolDescriptor[]>;
  /** Add a freshly resolved descriptor into the LIVE toolset. prepareStep
   * re-reads activeToolNames() each step, so it's callable next step. */
  materialize?: (descriptor: ToolDescriptor) => void;
}

export function createToolSearchSession(options: ToolSearchSessionOptions): ToolSearchSession {
  const available = new Set(options.descriptors.map((descriptor) => descriptor.name));
  // Toolkit per tool name, so a search result can be annotated connect-required.
  // Updated when a lazily expanded tool is resolved mid-search.
  const toolkits = new Map<string, string | undefined>(
    options.descriptors.map((d) => [d.name, (d as { toolkit?: string }).toolkit]),
  );
  const initial = computeInitialLoadout(options.descriptors, options.config, options.seedNames, options.menuNames);
  // THIS turn's menu. `loaded` persists across turns within a thread, so a tool
  // searched in while the menu was unresolved (the degrade-to-unrestricted
  // window) would otherwise stay active on every later turn — including turns
  // whose recovered `surfaces.agent` menu excludes it. The re-add below is
  // therefore re-checked against the menu every step, not just at load time.
  const menu = options.menuNames === undefined ? undefined : new Set(options.menuNames);
  // Captured at attach: the full run toolset. Every Vendo-owned `vendo_*` tool
  // in it stays active regardless of loadout — including the OTHER meta-tools
  // (notably `vendo_report_capability_miss`) that are attached after the host
  // descriptors and so are NOT in `options.descriptors`. Gating them out would
  // silently disable miss capture whenever tool search is on.
  let attached: ToolSet | undefined;

  return {
    activeToolNames() {
      const active = new Set<string>(initial);
      active.add(FIND_TOOLS_TOOL_NAME);
      for (const name of Object.keys(attached ?? {})) if (isAlwaysActive(name)) active.add(name);
      for (const name of options.loaded) {
        if (available.has(name) && offeredByMenu(menu, name)) active.add(name);
      }
      return [...active];
    },

    attach(tools) {
      attached = tools;
      if (tools[FIND_TOOLS_TOOL_NAME] !== undefined) {
        throw new VendoError("conflict", `Reserved internal tool name: ${FIND_TOOLS_TOOL_NAME}`);
      }
      tools[FIND_TOOLS_TOOL_NAME] = dynamicTool({
        description:
          "Search this product's tools and connected-service tools by intent, and LOAD the matches so you can call them this run. "
          + "Use this only when no currently-available tool fits the ask — never to browse or enumerate what exists. "
          + "Results may include tools for services the user has NOT connected yet; an unconnected service surfaces an inline connect card "
          + "WITHOUT its tools running, so do not keep calling tools of a service you know is unconnected.",
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
            matches = await options.config.search(
              query,
              limit === undefined ? undefined : { limit },
              options.ctx,
            );
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
                toolkits.set(descriptor.name, (descriptor as { toolkit?: string }).toolkit);
              }
            } catch {
              // Unresolved names simply stay unloadable below.
            }
          }
          // Only load names that actually exist in this run's guard-bound toolset
          // — a stale or drifting search seam can never conjure an unbound tool.
          const loadable = matches.filter((match) => available.has(match.name));
          for (const match of loadable) options.loaded.add(match.name);
          // Annotate the unconnected ones. A result the model cannot actually run
          // yet has to say so, or it burns a turn calling it and reads the refusal
          // as a failure — which is exactly the loop the connect card exists to
          // replace. `toolkit` comes off the descriptor (01-core §4).
          const annotate = async (match: ToolSearchMatch): Promise<Record<string, unknown>> => {
            const row: Record<string, unknown> = {
              name: match.name, description: match.description, risk: match.risk,
            };
            const toolkit = toolkits.get(match.name);
            if (toolkit === undefined) return row;
            row["toolkit"] = toolkit;
            if (options.config.connectRequired === undefined) return row;
            try {
              if (options.ctx !== undefined
                  && await options.config.connectRequired(toolkit, options.ctx)) {
                row["connectRequired"] = true;
              }
            } catch {
              // A failed lookup must never fail the search; the tool's own
              // connect-required outcome still catches the call.
            }
            return row;
          };
          return {
            status: "ok",
            output: {
              loaded: loadable.map((match) => match.name),
              tools: await Promise.all(loadable.map(annotate)),
            },
          };
        },
      });
    },
  };
}
