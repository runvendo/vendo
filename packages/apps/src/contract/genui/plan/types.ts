/**
 * The app plan — what the brain writes before workers fill anything in
 * (docs/superpowers/plans/2026-07-28-generation-pipeline-rebuild.md, "Locked
 * interfaces"; design in
 * docs/superpowers/specs/2026-07-28-generation-pipeline-v2-design.md).
 *
 * ONE shape, flat: queries, then groups of leaves, plus the rare escapes
 * (island, server work) and honest refusals. Structure is exactly two levels
 * deep — groups hold leaves, nothing holds groups — because a group is the
 * coherence unit one fill worker writes whole. Arrangement inside a group is
 * the group's own `layout`, never nesting.
 *
 * Tabs are NOT part of the shape: they derive from the groups' tab labels
 * (see {@link planTabs}).
 */

/** One host-data read the plan declares once and leaves reference by id.
 *  Executed at plan time (read-risk only), so workers see real sample rows. */
export interface PlanQuery {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** One part of a group: which component shows it, and one sentence of what it
 *  is for. Nothing else — the skeleton reads the component, the fill worker
 *  reads the purpose, and a field no consumer reads is a field the format
 *  would have to define normatively for nothing. */
export interface PlanLeaf {
  component: string;
  purpose: string;
}

/** A handful of parts that must tell one story — written by one worker. */
export interface PlanGroup {
  /** Tabs derive from these labels, in order of first appearance; groups
   *  without one belong to a single-surface app. */
  tab?: string;
  title?: string;
  layout?: "stack" | "grid";
  /** This group fills after the sandbox box reports its real interface. */
  waitsForServer?: boolean;
  leaves: PlanLeaf[];
}

/** Work that cannot happen in the browser: scheduled steps, an agentic run,
 *  or a backend the sandbox builds. `why` is the earned justification. */
export interface PlanServer {
  kind: "steps" | "agentic" | "box";
  schedule?: string;
  why: string;
  /**
   * Layer 3: the machine serves the whole app surface, not just functions.
   * The LAST resort — earned only by an interaction model no composite or island
   * can express (drag-and-drop between columns, a rich-text editor).
   *
   * It is declared in the PLAN on purpose. Flipping means the app's tree is
   * deleted, so it takes TWO independent signals: this declaration, and the
   * host's own verification that the box really serves a page. A box that
   * decides on its own that it serves UI must never replace a tree the person
   * did not ask to lose.
   */
  served?: boolean;
}

/** Where a finished view should LAND (redesign spec §5, pick V4): a small
 *  answer-shaped view arrives inline as a card, a multi-section build opens the
 *  split view and assembles on the stage. Declared at plan time because that is
 *  the only moment early enough for the stage to be open while the skeleton is
 *  still worth watching. It sets the STARTING posture only — inline keeps
 *  Expand, staged keeps Back-to-chat, so a wrong hint costs one tap. */
export const PLAN_DISPLAYS = ["inline", "stage"] as const;

export type PlanDisplay = (typeof PLAN_DISPLAYS)[number];

export interface AppPlan {
  name: string;
  queries: PlanQuery[];
  groups: PlanGroup[];
  /** Absent means inline — the default posture, and what every plan written
   *  before this field existed means. */
  display?: PlanDisplay;
  server?: PlanServer;
  /** Honest refusals, verbatim user-facing. */
  cannot: string[];
}

/** The app's tabs: each distinct group tab label, in order of first
 *  appearance. Empty means one surface with no tab chrome. */
export const planTabs = (plan: AppPlan): string[] => {
  const tabs: string[] = [];
  for (const group of plan.groups) {
    if (group.tab !== undefined && !tabs.includes(group.tab)) tabs.push(group.tab);
  }
  return tabs;
};
