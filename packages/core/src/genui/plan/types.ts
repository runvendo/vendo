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
 * attributes (col/row/span), never nesting.
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

/** One part of a group: which component shows it, which query feeds it, and
 *  one sentence of what it is for. `attrs` carries arrangement hints
 *  (col/row/span) as written. */
export interface PlanLeaf {
  component: string;
  query?: string;
  purpose: string;
  attrs?: Record<string, string>;
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

/** A custom component the plan asks for because no component can express it. */
export interface PlanIsland {
  name: string;
  purpose: string;
}

/** Work that cannot happen in the browser: scheduled steps, an agentic run,
 *  or a backend the sandbox builds. `why` is the earned justification. */
export interface PlanServer {
  kind: "steps" | "agentic" | "box";
  schedule?: string;
  why: string;
}

export interface AppPlan {
  name: string;
  queries: PlanQuery[];
  groups: PlanGroup[];
  island?: PlanIsland;
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
