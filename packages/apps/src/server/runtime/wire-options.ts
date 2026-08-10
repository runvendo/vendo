import type {
  compileWire,
} from "../../contract/index.js";
import type { FloorDependencies } from "../checking/deps.js";

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
  // The host's own risk grading, forwarded to the tree so the renderer confirms
  // before it sends a mutating call (`Tree.writeTools`). Anything not graded
  // `read` counts, `ungraded` included — the guard treats an ungraded tool like a
  // destructive one, and a surface that asked less than the guard would be
  // promising safety it does not have.
  ...(deps.tools === undefined
    ? {}
    : { writeTools: deps.tools.filter(({ risk }) => risk !== "read").map(({ name }) => name) }),
});
