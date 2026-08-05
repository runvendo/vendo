import type { compileWire } from "@vendoai/core";
import type { FloorDependencies } from "./checking/deps.js";

/** The production compile options: inline tool refs ON everywhere model wire is
 *  compiled (the registry names enable single-segment production tool heads);
 *  `<Query>` declarations stay accepted unchanged. Owned HERE so every compile
 *  of model wire — a whole app, one fill fragment, an edited app's text, a
 *  harness's own `app.vendo` at the paint seam — speaks the exact same dialect.
 *  Live 2026-07-23: one recompile that lacked these options failed EVERY app
 *  built on inline references.
 *
 *  It sits at the package root rather than in `generation/`: the pipeline is
 *  quarantined (§14.2) and the DIALECT has to outlive it. Its readers are now the
 *  conductor, the fill workers, the island lane, `AppsRuntime.validate` and the
 *  checks floor.
 *
 *  `hostComponents` is derived rather than passed: all five call sites read
 *  `deps.catalog` for it, and two of them had their own copy of that one-liner. */
export const wireCompileOptionsFor = (
  deps: FloorDependencies,
): Parameters<typeof compileWire>[1] => ({
  hostComponents: deps.catalog.map(({ name }) => name),
  inlineRefs: true,
  ...(deps.tools === undefined ? {} : { inlineTools: deps.tools.map(({ name }) => name) }),
  ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
});
