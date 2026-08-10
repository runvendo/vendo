/**
 * The view channel's contract: what a compiled screen looks like on its way to a
 * slot.
 *
 * Before this, the channel carried `UIPayload` — `{ formatVersion: string;
 * [key: string]: unknown }`, an open bag whose seven real fields were read by
 * inline cast at each consumer. A deployed host frontend had nothing to hold us
 * to. This declares the fields, and versions them: renderers dispatch on
 * `formatVersion`, an unregistered tag is a contained failure, additive fields are
 * fine, and a changed or removed field means a NEW tag.
 *
 * Two laws are in the shape itself:
 *
 * 1. **No data.** A description says what to fetch (`queries`), never what came
 *    back. The slot asks for its own values, as the viewer, through the one
 *    guarded query path. `data` on this channel would be a server deciding what a
 *    viewer may see at paint time instead of at ask time, so the schema refuses
 *    the key outright rather than merely omitting it.
 * 2. **No islands.** `components`/`componentTools` are not part of this contract.
 *    Legacy island apps keep flowing through the open payload shape they always
 *    did; nothing new enters through here.
 */
import { z } from "zod";
import {
  type TreeNode,
  treeNodeSchema,
  VENDO_TREE_FORMAT,
} from "@vendoai/core";
import { treeQuerySchema, type TreeQuery } from "./tree.js";
import { PLAN_DISPLAYS, type PlanDisplay } from "./plan/types.js";

/**
 * The view channel's version tag — the SAME tag the tree format already carries,
 * named once so there is one literal and one thing to bump. A second constant
 * with the same value would be two versions of one version.
 */
export const VENDO_SCREEN_FORMAT = VENDO_TREE_FORMAT;

/**
 * One drifted pin as it rides a description. The full shape belongs to
 * `@vendoai/apps` (`PinDrift`, which core may not import); declared here as the
 * part the channel promises, and passthrough so the rest travels intact.
 */
export interface ScreenSeedDrift {
  slot: string;
  component: string;
}

/** The described screen, as the view channel carries it. */
export interface ScreenDescription {
  formatVersion: typeof VENDO_SCREEN_FORMAT;
  root: string;
  nodes: TreeNode[];
  /** WHAT to fetch — never the results. */
  queries?: TreeQuery[];

  // Everything below is SERVER-AUTHORITATIVE: the model may never author these,
  // and `stripServerAuthoritativeFields` removes them from anything stored.

  /** Still forming. MUST flip false on the final paint — while it is true the
   *  renderer holds the skeleton and never reaches a verdict. */
  streaming?: boolean;
  /** A query FAILED. Distinct from "empty": every unresolved binding renders "—",
   *  so without this a failed load is indistinguishable from "you have nothing". */
  dataUnavailable?: boolean;
  /** Inline in the conversation, or on the staging surface. */
  display?: PlanDisplay;
  /** The in-client (unjailed) verdict for this app's forked pins. Shape owned by
   *  `@vendoai/apps` (`InClientVenueState`); the channel promises the verdict and
   *  the version it was reached on. */
  inClient?: { granted: boolean; versionHash: string };
  pinDrift?: ScreenSeedDrift[];
}

/**
 * Structural gate for the view channel, in the types+zod pairing convention.
 *
 * Passthrough, like every core schema, so an additive field and a legacy island
 * app's extra keys both travel — with ONE exception: `data` is refused. That is
 * the field this contract exists to keep off the channel, so a passthrough that
 * let it slide would make the law unenforceable.
 */
export const screenDescriptionSchema = z.object({
  formatVersion: z.literal(VENDO_SCREEN_FORMAT),
  root: z.string().min(1),
  nodes: z.array(treeNodeSchema),
  queries: z.array(treeQuerySchema).optional(),
  streaming: z.boolean().optional(),
  dataUnavailable: z.boolean().optional(),
  display: z.enum(PLAN_DISPLAYS).optional(),
  inClient: z.object({
    granted: z.boolean(),
    versionHash: z.string().min(1),
  }).passthrough().optional(),
  pinDrift: z.array(z.object({
    slot: z.string().min(1),
    component: z.string().min(1),
  }).passthrough()).optional(),
  data: z.never().optional(),
}).passthrough() satisfies z.ZodType<ScreenDescription & { data?: never }>;
