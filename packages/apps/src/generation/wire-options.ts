import {
  compileWireV2,
  printWireV2,
  type TreeV2,
  type WireCompileResult,
} from "@vendoai/core";
import type { GenerationDependencies, PipelineContext } from "./engine.js";

/** The production compile options: inline tool refs ON everywhere model wire
 *  is compiled (the registry names enable single-segment production tool
 *  heads); `<Query>` declarations stay accepted unchanged. Owned HERE so the
 *  stages' own compiles (region-parallel assembly, repair/end-pass
 *  recompiles) use the exact options the engine's streaming lanes use —
 *  live 2026-07-23: the assembly recompile lacked them, so EVERY app built
 *  on inline references failed region-parallel with "unknown-reference". */
export const wireCompileOptionsFor = (
  deps: GenerationDependencies,
  hostComponents: readonly string[],
): Parameters<typeof compileWireV2>[1] => ({
  hostComponents: [...hostComponents],
  inlineRefs: true,
  ...(deps.tools === undefined ? {} : { inlineTools: deps.tools.map(({ name }) => name) }),
  ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
});

/** Re-print then re-compile a patched/spliced tree so it goes back through
 *  the ONE create validator exactly as model wire would. Owned here (not in
 *  a stage) so verify and repair can both use it without importing each
 *  other — the verify→repair→verify cycle is a TDZ crash under bundlers. */
export const recompile = (
  base: { tree: TreeV2; components: Record<string, string>; name?: string },
  context: PipelineContext,
): WireCompileResult => compileWireV2(
  printWireV2(base, { includeIds: false }),
  // The production compile options (inline tool refs included) — a patched
  // tree must recompile in the exact dialect the streaming lanes used.
  wireCompileOptionsFor(context.deps, context.hostComponents),
);
