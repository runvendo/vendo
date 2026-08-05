/**
 * What the checking floor needs to measure an app against — and nothing else.
 *
 * Blueprint §7.3: the floor used to speak `GenerationDependencies`, the whole
 * generation pipeline's dependency bag, which made `checking/` and
 * `generation/` mutually entangled and pinned the conductor alive. A full read of
 * this directory says the floor dereferences exactly FOUR fields, so those four
 * are the type. `GenerationDependencies` extends it, so every conductor call site
 * keeps working unchanged — and the floor now runs anywhere a catalog and a model
 * exist, which is what lets it move to the paint seam.
 */
import type { NormalizedCatalog, ShapeType } from "@vendoai/core";
import type { LanguageModel } from "ai";

/** The slice of a tool descriptor the floor (and the generation prompts) need:
 *  prompt context and the query-tool existence check.
 *
 *  It lives HERE, with the floor, because the floor is the thing that decides
 *  whether a query names a tool the host really has (`unknownToolIssues`) — and
 *  because a type the floor owns cannot follow the pipeline into quarantine. The
 *  generation engine re-exports it, so its own consumers are unaffected. */
export interface HostToolInfo {
  name: string;
  description: string;
  risk: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * The host surface a check measures against.
 *
 * `model` is here for the AI reviewer alone — it is the one check that spends a
 * model call — and it is REQUIRED for the same reason `AppsRuntime.validate`
 * refuses without one: a floor that silently drops its judgment half would report
 * a clean bill of health on an app nobody read.
 */
export interface FloorDependencies {
  model: LanguageModel;
  /** The composition-normalized catalog (01 §14): propsJsonSchema is derived. */
  catalog: NormalizedCatalog;
  /** Shape-card outputs keyed by tool. Absent → the binding, kit-slot and
   *  expression checks have nothing to compare against and stay silent. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools a query may name. Absent → `tools-exist` stays silent. */
  tools?: readonly HostToolInfo[];
}
