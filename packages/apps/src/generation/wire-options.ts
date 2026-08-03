import type { compileWire } from "@vendoai/core";
import type { GenerationDependencies } from "./engine.js";

/** The production compile options: inline tool refs ON everywhere model wire is
 *  compiled (the registry names enable single-segment production tool heads);
 *  `<Query>` declarations stay accepted unchanged. Owned HERE so every compile
 *  of model wire — a whole app, one fill fragment, an edited app's text —
 *  speaks the exact same dialect. Live 2026-07-23: one recompile that lacked
 *  these options failed EVERY app built on inline references. */
export const wireCompileOptionsFor = (
  deps: GenerationDependencies,
  hostComponents: readonly string[],
): Parameters<typeof compileWire>[1] => ({
  hostComponents: [...hostComponents],
  inlineRefs: true,
  ...(deps.tools === undefined ? {} : { inlineTools: deps.tools.map(({ name }) => name) }),
  ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
});
