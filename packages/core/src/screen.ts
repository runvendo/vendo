/**
 * The screen-assembly seam — UI-generation blueprint §1 point 2 and §4.2.
 *
 * "The seam routes, not the caller." No agent chooses "quick screen" vs "real
 * build": every `vendo_make` request starts in the cheap screen agent, and the
 * conductor is what an escalation or an unserved ask falls through to.
 *
 * The screen agent itself is a lean loop in `@vendoai/harnesses` — it needs a
 * model, the guard-bound registry, and a workspace whose commits reach the render
 * seam, none of which `@vendoai/apps` holds. `apps` depends on `core` alone, so
 * the two sides meet on this interface and composition (`packages/vendo`) is the
 * only place that fills the slot. That is the shipped adapter rule: an explicitly
 * passed adapter always wins, an unfilled slot changes nothing, and there is no
 * hidden key-conditional branch. Unset — or set and answering anything but
 * `assembled` — and the conductor path runs exactly as it did before this seam
 * existed.
 */
import type { AppId } from "./ids.js";
import type { RunContext } from "./run-context.js";
import type { VendoViewPart } from "./stream-parts.js";

/** One ask, as the front door hands it over. */
export interface ScreenRequest {
  /**
   * The app id this request is FOR, minted by the front door rather than by the
   * assembler.
   *
   * The screen agent's files live at `/user/apps/<appId>/`, the painted view
   * rides `vendoViewStreamId(appId)`, and an escalated plan has to become the
   * build's first skeleton — all three only line up if the id is the same one the
   * conductor would go on to use, so the caller owns it.
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
 * `unavailable` is "nothing ran", which is what an unwired or broken assembler
 * answers. Both fall through to the conductor.
 */
export type ScreenOutcome =
  | { kind: "assembled" }
  | { kind: "escalate"; why: string }
  | { kind: "unavailable"; why: string };

export interface ScreenAssembler {
  assemble(request: ScreenRequest, ctx: RunContext): Promise<ScreenOutcome>;
}
