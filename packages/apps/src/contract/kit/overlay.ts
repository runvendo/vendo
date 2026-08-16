/**
 * The overlay bricks — the three Kit components that paint OUTSIDE the screen's
 * own box (Modal, Sheet, Toast).
 *
 * What separates them from every other brick is the pair of props that drives
 * them: one boolean the screen raises them with, one handler they close through.
 * A consumer that must treat an overlay differently — the renderer routing the
 * node to the chrome overlay host instead of painting it in place — reads that
 * pair from here rather than matching on the component's name.
 */
import { KIT_SPECS } from "./specs.js";

export interface KitOverlaySpec {
  kind: "modal" | "sheet" | "toast";
  /** The boolean prop that decides whether the overlay is on screen. */
  openProp: string;
  /** The handler the overlay calls when it wants to be taken down. */
  closeProp: string;
  /** Whether a press outside or an Esc takes it down. A toast has neither — it
   *  leaves on its own timer, so nothing outside it can be a dismissal. */
  dismissable: boolean;
}

const OVERLAYS: Readonly<Record<string, KitOverlaySpec>> = {
  Modal: { kind: "modal", openProp: "open", closeProp: "onClose", dismissable: true },
  Sheet: { kind: "sheet", openProp: "open", closeProp: "onClose", dismissable: true },
  Toast: { kind: "toast", openProp: "open", closeProp: "onClose", dismissable: false },
};

/** Every overlay brick, keyed by component name. Filtered THROUGH `KIT_SPECS`,
 *  so a name that is not a real Kit component cannot survive here. */
export const KIT_OVERLAY_SPECS: Readonly<Record<string, KitOverlaySpec>> = Object.fromEntries(
  KIT_SPECS
    .filter((spec) => OVERLAYS[spec.name] !== undefined)
    .map((spec) => [spec.name, OVERLAYS[spec.name]!]),
);
