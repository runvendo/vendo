import { createArmingSurface } from "./arming-surface.js";
import { createDocumentEditSurface } from "./document-edit-surface.js";
import { createEngineModules } from "./engine-context.js";
import { createIngestionSurface } from "./ingestion-surface.js";
import { createListSurface } from "./list-surface.js";
import { createRunsSurface } from "./runs-surface.js";
import type { AutomationsConfig, AutomationsEngine } from "./index.js";

/**
 * 07 §1 — construct the arming, listing, ingestion and run-history surface.
 *
 * An assembler, and nothing else: `createEngineModules` wires the closure
 * (engine-context.ts), and every door below is a module returning its slice of
 * `AutomationsEngine`, handed the modules it reads BY NAME. The engine's
 * internal shapes moved to types.ts (the row schemas and the doors that read
 * them used to sit ~2,000 lines apart in this file); nothing here is exported
 * from the package root, so no importer changes.
 */
export const createAutomationsEngine = (config: AutomationsConfig): AutomationsEngine => {
  const modules = createEngineModules(config);
  // Returned as a thenable so a guard that awaits subscribers (ours does)
  // makes decide() deterministic through resumption; guards that don't still
  // get fire-and-forget behavior.
  config.guard.onApprovalDecision((approvalId, approved) =>
    modules.consent.handleDecision(approvalId, approved) as unknown as void);
  return {
    ...createArmingSurface(modules),
    ...createListSurface(modules),
    ...createIngestionSurface(modules),
    ...createDocumentEditSurface(modules),
    runs: createRunsSurface(modules),
  };
};
