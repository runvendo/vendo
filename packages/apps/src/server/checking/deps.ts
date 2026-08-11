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
import type {
  JsonSchema,
  ShapeType,
} from "@vendoai/core";
import type {
  NormalizedCatalog,
} from "../../contract/index.js";
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
  /** The tool's DECLARED result shape (`ToolDescriptor.outputSchema`). The
   *  screen type check reads it directly: it is the host's own contract, and
   *  it keeps what a sample erased — an enum field samples as a bare `string`,
   *  so a prop that takes the enum could never be satisfied from a sample. */
  outputSchema?: JsonSchema;
}

/** A tool that CHANGES something. The smoke-render gate stubs these with the
 *  approval pipe's answer instead of a sample, and a component screen may not
 *  name one in `useQuery` — a read runs on every render. It lives here with
 *  {@link HostToolInfo}, so the two readers share one definition. */
export const isMutatingTool = (tool: HostToolInfo | undefined): boolean =>
  tool?.risk === "write" || tool?.risk === "destructive";

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
  /**
   * The seat the AI REVIEWER's own call rides, when the deployment composed a
   * cheaper one (`AppsConfig.reviewModel`).
   *
   * Judging a finished screen against its own rows is a reading job, not a
   * writing one, and it is the only check that spends a model call — so it runs
   * on the family's fast pick rather than on the model that wrote the app.
   * Absent, it rides `model` above, exactly as it always did.
   */
  reviewModel?: LanguageModel;
  /** The composition-normalized catalog (01 §14): propsJsonSchema is derived. */
  catalog: NormalizedCatalog;
  /** Each tool's declared response schema in structural form
   *  (`shapeFromJsonSchema`), keyed by tool. Absent → the binding, kit-slot and
   *  expression checks have nothing to compare against and stay silent. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools a query may name. Absent → `tools-exist` stays silent. */
  tools?: readonly HostToolInfo[];
  /**
   * The island smoke-render gate: every island renders once in a headless DOM
   * before it ships, so a crashing island never reaches a screen. ON unless
   * explicitly `false` — the seam the island tests run without.
   *
   * It lives on the FLOOR, not on the generation bag above it, because the
   * floor is the other half that runs the gate. It was declared only on
   * `GenerationDependencies`, so `create` honoured the switch and the floor
   * never saw it: a host that turned the render off still paid for one on every
   * commit, and was blocked by a gate it had disabled.
   */
  pipeline?: {
    smokeRender?: boolean;
  };
}
