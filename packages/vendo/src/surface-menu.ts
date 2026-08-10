import { CONNECTOR_DISCOVERY_TOOLS, type ToolRegistry } from "@vendoai/core";
import { VENDO_TOOL_PACK_PREFIX } from "./tool-pack.js";

/**
 * The composition seam's cache for a resolved per-surface tool menu
 * (`.vendo/overrides.json` `surfaces.*`, via `ActionsRegistry.surfaceMenu`).
 *
 * A menu is boot configuration, so a SUCCESSFUL resolution is cached for the
 * process. A FAILED one never is: caching a rejection would freeze the surface
 * into whatever the failure degraded to (here, unrestricted) for the life of
 * the process, long after the cause was fixed. A failure also has to be loud —
 * silently serving an unrestricted surface because a file could not be read is
 * exactly the kind of quiet wrong answer that ships.
 *
 * Degrading to unrestricted (rather than empty) is deliberate: a menu is
 * curation, not a permission boundary, so failing to read one must not silently
 * disarm a product's agent. The guard, `disabled`, and audience exclusions are
 * what actually restrict, and none of them run through here.
 */
export function memoizedSurfaceMenu(
  resolve: () => Promise<string[] | undefined>,
  warn: (message: string) => void = (message) => console.warn(message),
): () => Promise<Set<string> | undefined> {
  let cached: Promise<Set<string> | undefined> | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const attempt = resolve()
      .then((names) => (names === undefined ? undefined : new Set(names)))
      .catch((error: unknown) => {
        cached = undefined;
        warn(
          "[vendo] could not resolve the agent's surfaces menu from .vendo/overrides.json; "
          + `serving the full tool surface this turn: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
    cached = attempt;
    return attempt;
  };
}

/**
 * Bind the host's `surfaces.agent` menu at the registry PROJECTION, so it holds
 * for EVERY brain — `vendo()`, `claudeCode()`, a host's own harness — instead of
 * riding one brain's loadout math (the pre-de-brain shape, where a non-vendo
 * harness never saw the menu at all).
 *
 * Same precedent as `withUniqueToolTitles(connectGate.bind(...))`: a thin
 * wrapper installed where the harness door's registry handle is assembled
 * (compose-harness.ts), and ONLY there — the MCP door has its own menu, and
 * `execute` is untouched because a menu is curation, not a permission boundary
 * (grants, approvals and audit still see every call that arrives with a name).
 *
 * Vendo's own `vendo_*` tools and the connector-discovery four are exempt:
 * surfaces curate a product's API surface, not the runtime's plumbing, and the
 * four carry no prefix while the system prompt teaches them by name — filtering
 * them out is the uiaudit-2026-08-06 regression (a curated host lost
 * `request_connection` while the prompt kept teaching it).
 */
export function withAgentMenu(
  tools: ToolRegistry,
  menu: () => Promise<ReadonlySet<string> | undefined>,
): ToolRegistry {
  const exempt: ReadonlySet<string> = new Set(CONNECTOR_DISCOVERY_TOOLS);
  return {
    ...tools,
    async descriptors(ctx) {
      const offered = await menu();
      const descriptors = await tools.descriptors(ctx);
      if (offered === undefined) return descriptors;
      return descriptors.filter(({ name }) =>
        name.startsWith(VENDO_TOOL_PACK_PREFIX) || exempt.has(name) || offered.has(name));
    },
  };
}
