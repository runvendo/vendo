/**
 * The screen-assembly seam — UI-generation blueprint §1 point 2 and §4.2.
 *
 * "The seam routes, not the caller." No agent chooses "quick screen" vs "real
 * build": every `vendo_make` request starts in the screen agent, and an
 * escalation is how it asks for the builder.
 *
 * The screen agent itself is a lean loop in `@vendoai/harnesses` — it needs a
 * model, the guard-bound registry, and a workspace whose commits reach the render
 * seam, none of which `@vendoai/apps` holds. `apps` depends on `core` alone, so
 * the two sides meet on this interface and composition (`packages/vendo`) is the
 * only place that fills the slot. That is the shipped adapter rule: an explicitly
 * passed adapter always wins and there is no hidden key-conditional branch. What
 * an unfilled slot no longer does is quietly hand the ask to a second engine —
 * `vendo_make` says it could not build the screen instead.
 */
import {
  type AppId,
  type RunContext,
  type VendoViewPart,
} from "@vendoai/core";

/** One ask, as the front door hands it over. */
export interface ScreenRequest {
  /**
   * The app id this request is FOR, minted by the front door rather than by the
   * assembler.
   *
   * The screen agent's files live at `/user/apps/<appId>/`, the painted view
   * rides `vendoViewStreamId(appId)`, and an escalated plan has to become the
   * build's first skeleton — all three only line up if the id is the same one the
   * build goes on to use, so the caller owns it.
   */
  appId: AppId;
  /** The person's ask, verbatim — never a paraphrase. */
  request: string;
  /** Where a painted view goes. The same additive per-call hook
   *  `AppsRuntime.create` takes, so a screen and a built app reach the surface on
   *  one channel. */
  onView?: (part: VendoViewPart) => void;
}

/**
 * Three answers, and no fourth.
 *
 * Only `assembled` means the caller is done: the view is on screen and the app's
 * row is stored. `escalate` is the mid-flight §4.5 hand-off — the plan is already
 * written and its skeleton is already painted, so the build inherits it — and
 * `unavailable` is "nothing ran", which is what a broken assembler answers. An
 * `unavailable` is the END of the ask: `vendo_make` reports it as a failed
 * receipt carrying `why`, so a deployment whose assembly is broken reads as
 * broken instead of being served by an engine nobody chose.
 */
export type ScreenOutcome =
  | {
      kind: "assembled";
      /**
       * What the assembling agent SAID when it finished — its own closing words,
       * verbatim, which `vendo_make` puts in the receipt's `say`.
       *
       * It travels because the builder is the only thing that knows what it built:
       * whether every save painted, and what each query actually delivered. The
       * front door used to compose that sentence from the app's name alone, so the
       * calling agent had a title and no facts and invented the rest. Absent when
       * the run said nothing (it ran out of steps, or was cut off) — the caller
       * falls back, and nothing here writes a sentence on the agent's behalf.
       */
      say?: string;
    }
  | { kind: "escalate"; why: string }
  | { kind: "unavailable"; why: string };

export interface ScreenAssembler {
  assemble(request: ScreenRequest, ctx: RunContext): Promise<ScreenOutcome>;
}
