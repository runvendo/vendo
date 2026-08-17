import type { AgentRunners } from "@vendoai/core";
import { createArmingSurface } from "./arming-surface.js";
import type { CreateSurfaceAccess } from "./create-surface.js";
import { createEngineModules } from "./engine-context.js";
import { createIngestionSurface } from "./ingestion-surface.js";
import { createListSurface } from "./list-surface.js";
import { createRunsSurface } from "./runs-surface.js";
import type { AutomationsConfig, AutomationsEngine } from "./index.js";

/** The INTERNAL half of the engine, reached through `automationsInternals`.
 *
 *  A WeakMap, the same idiom `agentComposition(agent)` uses, and for the same
 *  reason: the public object stays exactly the public API. `create` and
 *  `reconcile` are how an automation comes into existence, and neither may be
 *  reachable from `vendo.automations` — a host that can enumerate and disarm
 *  automations must not be able to mint one for somebody else. */
const internals = new WeakMap<AutomationsEngine, AutomationsInternals>();

export interface AutomationsInternals extends CreateSurfaceAccess {
  /** Boot-time agent registration. A duplicate name throws HERE, at startup. */
  runners: AgentRunners;
}

export const automationsInternals = (engine: AutomationsEngine): AutomationsInternals => {
  const found = internals.get(engine);
  if (found === undefined) throw new Error("not a Vendo automations engine");
  return found;
};

/**
 * 07 §1 — construct the arming, listing, ingestion and run-history surface.
 *
 * An assembler, and nothing else: `createEngineModules` wires the closure
 * (engine-context.ts), and every door below is a module returning its slice of
 * `AutomationsEngine`, handed the modules it reads BY NAME.
 */
export const createAutomationsEngine = (config: AutomationsConfig): AutomationsEngine => {
  const modules = createEngineModules(config);
  // Returned as a thenable so a guard that awaits subscribers (ours does) makes
  // decide() deterministic through resumption; guards that don't still get
  // fire-and-forget behavior.
  config.guard.onApprovalDecision((approvalId, approved) =>
    modules.consent.handleDecision(approvalId, approved) as unknown as void);
  const engine: AutomationsEngine = {
    ...createArmingSurface(modules),
    ...createListSurface(modules),
    ...createIngestionSurface(modules),
    runs: createRunsSurface(modules),
  };
  internals.set(engine, { ...modules.writes, runners: modules.runners });
  return engine;
};
