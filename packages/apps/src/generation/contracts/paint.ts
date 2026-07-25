/**
 * The tier-0 instant-paint contract: the paint lane emits a complete,
 * fully-WIRED generic app immediately; the full lane then upgrades it in
 * place by stable id.
 */
import type { WireCompileResult } from "@vendoai/core";
import type { GenerationDependencies } from "../engine.js";
import { createContract } from "./create.js";

export const tier0Contract = (deps: GenerationDependencies): string => `${createContract(deps)}

PAINT PASS (tier-0): emit a complete, minimal, fully-wired GENERIC app for the request RIGHT NOW.
- Catalog components with conservative default props; real inline tool references (or <Query> declarations) for the most relevant read tools so live data flows immediately.
- NO <Island> code islands — catalog and prewired components only.
- Keep it small (well under 40 nodes) and generic; a full-quality pass will replace it subtree-by-subtree, so favor a stable, conventional layout over cleverness.`;

/** The compact tier-0 structure the full lane is conditioned on: minted id +
 *  component per node, in document order, so the full lane can keep the
 *  layout ordering (and therefore the minted ids) stable for in-place
 *  hot-swap. */
export const layoutHeader = (compiled: WireCompileResult): string =>
  compiled.tree.nodes.map((node) => `${node.id}:${node.component}`).join(" ");
