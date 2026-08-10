/**
 * Design facts read off ISLAND SOURCE — the one artefact nothing in the product
 * inspects for anything a person would see. `prepareIslands` reads it for
 * imports, network and tool names; `smokeRenderIslands` executes it for crashes
 * and says so in its own header ("deliberately does NOT judge visual
 * wrongness"). So a whole screen of rows can be handed over with every press
 * handler sitting on a bare `<div>`, and every gate says yes.
 *
 * NOT part of `factChecks` or `floorChecks`: those are the paint seam's checks,
 * and the seam declines to paint on a `block` (`render-seam.ts`). This runs on
 * the `validate` door, where a block is a repair instruction rather than a blank
 * screen.
 */
import {
  componentSources,
  type AppDocument,
} from "../../contract/index.js";
import type { Check, Finding } from "./types.js";

/** One JSX opening tag of a non-interactive element, captured whole so the
 *  `role` beside a handler is visible. `=>` is stepped over deliberately: an
 *  arrow body carries a `>`, and `[^>]*` alone stops inside the very handler
 *  this is looking for. */
const PLAIN_ELEMENT_TAG = /<\s*(?:div|span|li|tr|td|section|article)\b(?:=>|[^>])*>/g;

const pressOnPlainElement = (source: string): boolean =>
  [...source.matchAll(PLAIN_ELEMENT_TAG)]
    .some(([tag]) => /\bonClick\b/.test(tag) && !/\brole\s*=\s*["']button["']/.test(tag));

const controlFindings = (document: AppDocument): Finding[] =>
  Object.entries(componentSources(document.components))
    .filter(([, source]) => pressOnPlainElement(source))
    .map(([name]) => ({
      severity: "block" as const,
      message: `island "${name}" — a press handler sits on a plain <div>, which is not a control:`
        + " it takes no keyboard focus, announces nothing, and no host or test can find it."
        + " Give the element role=\"button\" tabIndex={0} and an onKeyDown that fires the same"
        + " handler on Enter and Space, or use the Kit <Button label=… onClick=…/> for the press.",
    }));

/** The island half of the design floor: a press must live on something that IS
 *  a control. Source-only, no model call — affordable anywhere `validate` is. */
export const islandControlsCheck: Check = {
  name: "island-controls",
  kind: "fact",
  run: async ({ document }) => controlFindings(document),
};
