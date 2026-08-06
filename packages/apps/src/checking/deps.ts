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
 * `model` is for the AI reviewer alone — the one check that spends a model call —
 * and it is OPTIONAL because the floor genuinely runs without one: the seven
 * deterministic fact checks are pure lookups, and the paint seam calls exactly
 * those. A modelless floor loses its judgment half the same way the reviewer loses
 * it for any other reason it cannot judge, which is fail-open by design ("a
 * reviewer that could not judge must never be the reason a good app dies").
 *
 * `AppsRuntime.validate` still refuses outright without a model, because a VERB
 * that answers "nothing wrong" after running only half its checks is the worst lie
 * a checker can tell. That is a door's contract, not the floor's.
 */
export interface FloorDependencies {
  model?: LanguageModel;
  /** The composition-normalized catalog (01 §14): propsJsonSchema is derived. */
  catalog: NormalizedCatalog;
  /** Shape-card outputs keyed by tool. Absent → the binding, kit-slot and
   *  expression checks have nothing to compare against and stay silent. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools a query may name. Absent → `tools-exist` stays silent. */
  tools?: readonly HostToolInfo[];
}
