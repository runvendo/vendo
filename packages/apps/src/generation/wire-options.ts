import type { compileWireV2 } from "@vendoai/core";
import type { GenerationDependencies } from "./engine.js";

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
