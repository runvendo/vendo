/**
 * The deterministic skeleton — the live plan-paint path.
 *
 * A plan is not a preview — it IS the app's layout. The moment a `plan.vendo`
 * file lands, the render seam turns it into the real tree with this
 * (`harnesses/render-seam.ts`): tab chrome derived from the group labels, one
 * titled surface per group, and one placeholder per leaf that shimmers until
 * the build fills it in. Nothing here calls a model; the same plan always
 * yields the same tree.
 *
 * Ids are positional ON PURPOSE. A plan streams in group by group, and the
 * skeleton is re-derived on every arrival, so an id may never depend on
 * anything that comes LATER (a count, a hash of the whole plan) — otherwise
 * the growing app re-mounts under the user instead of filling in.
 */
import {
  VENDO_TREE_FORMAT,
  planTabs,
  type AppPlan,
  type Json,
  type Tree,
  type TreeNode,
  type TreeQuery,
} from "@vendoai/core";

export interface Skeleton {
  tree: Tree;
}

const APP_ID = "app";
const TAB_CHROME_ID = "tabs";
const groupId = (index: number): string => `group-${index}`;
const tabPanelId = (index: number): string => `tab-${index}`;

/** The plan's layout as a tree, with every leaf still pending. */
export const skeletonFromPlan = (plan: AppPlan): Skeleton => {
  const from = 0;
  const tabs = planTabs(plan);
  const nodes: TreeNode[] = [];
  const groupIdsWithTab = (tab: string | undefined): string[] =>
    plan.groups.flatMap((group, index) => (group.tab === tab ? [groupId(from + index)] : []));

  // Groups the plan never labelled stand above the tab bar as one shared
  // surface — a label-less group belongs to no tab, and hiding it inside the
  // first one would be a quiet lie about where it lives.
  nodes.push({
    id: APP_ID,
    component: "Stack",
    source: "prewired",
    children: [
      ...groupIdsWithTab(undefined),
      ...(tabs.length === 0 ? [] : [TAB_CHROME_ID]),
    ],
  });

  if (tabs.length > 0) {
    // The panels are the bar's CHILDREN, one per tab in tab order — that
    // nesting is what makes the bar own which panel shows (packages/ui
    // kit/feedback/tabs.tsx Tabs), so switching tabs never leaves the browser.
    // This node shape is a FIXED SEAM: the Kit Tabs is written to satisfy it,
    // and packages/ui test/tree/tabs-skeleton-seam.test.tsx renders exactly
    // this through the real renderer so the two cannot drift.
    nodes.push({
      id: TAB_CHROME_ID,
      component: "Tabs",
      source: "prewired",
      props: { tabs: tabs.map((label) => ({ value: label, label })), value: tabs[0] as string },
      children: tabs.map((_, index) => tabPanelId(index)),
    });
    for (const [index, label] of tabs.entries()) {
      nodes.push({
        id: tabPanelId(index),
        component: "Stack",
        source: "prewired",
        children: groupIdsWithTab(label),
      });
    }
  }

  for (const [position, group] of plan.groups.entries()) {
    const index = from + position;
    const id = groupId(index);
    const slot = `${id}-body`;
    const title = group.title === undefined ? undefined : `${id}-title`;
    nodes.push({
      id,
      component: "Surface",
      source: "prewired",
      children: [...(title === undefined ? [] : [title]), slot],
    });
    if (title !== undefined) {
      nodes.push({
        id: title,
        component: "Text",
        source: "prewired",
        props: { text: group.title as string, variant: "heading" },
      });
    }
    // A grid group's column count is decided here: one column per leaf, capped
    // at four — beyond that a single row is unreadable at panel width.
    nodes.push({
      id: slot,
      component: group.layout === "grid" ? "Grid" : "Stack",
      source: "prewired",
      ...(group.layout === "grid"
        ? { props: { columns: Math.min(Math.max(group.leaves.length, 1), 4) } }
        : {}),
      children: group.leaves.map((_, leaf) => `${id}-leaf-${leaf}`),
    });
    for (const [leaf, { component }] of group.leaves.entries()) {
      // `pending: true` is the renderer's cue to hold the component's shimmer
      // silhouette (packages/ui tree/renderer.tsx) — the app's real geometry,
      // arriving in pieces, never a spinner over the whole surface.
      nodes.push({ id: `${id}-leaf-${leaf}`, component, source: "prewired", props: { pending: true } });
    }
  }

  const queries: TreeQuery[] = plan.queries.map((query) => ({
    name: query.id,
    tool: query.tool,
    input: query.input as Record<string, Json>,
  }));
  return {
    tree: {
      formatVersion: VENDO_TREE_FORMAT,
      root: APP_ID,
      nodes,
      ...(queries.length === 0 ? {} : { queries }),
    },
  };
};

/**
 * `<Leaf component="...">` and `<Group>` are the PLAN's own wrapper tags, and
 * `query`/`purpose` are the PLAN's vocabulary for describing a leaf — none of
 * it is real component markup, but a worker reading its own group's leaf list
 * (or the brain writing a whole app in one shot) routinely copies the plan's
 * syntax onto the element it writes instead of the real thing the plan asked
 * for. The renderer drops what it does not recognise and the checks report
 * the rest as an unknown component, which is just noise about something no
 * one can act on, so both come off here: a `<Leaf component="Stat">` becomes
 * the `Stat` it names, a `<Group>` becomes the `Stack` it always meant, and
 * `query`/`purpose`/the now-consumed `component` come off every node's props.
 *
 * Only on nodes the worker itself invented: a `source: "host"` node names a
 * real host component, and a host is entitled to declare a prop — or a
 * component — called whatever it likes; silently rewriting one would be the
 * worse bug.
 */
export const withoutPlanVocabulary = (node: TreeNode): TreeNode => {
  if (node.source === "host") return node;
  const props = node.props as Record<string, unknown> | undefined;
  const renamed = node.component === "Leaf" && typeof props?.component === "string"
    ? props.component
    : node.component === "Group"
      ? "Stack"
      : undefined;
  if (props === undefined) {
    return renamed === undefined ? node : { ...node, component: renamed };
  }
  const { query: _query, purpose: _purpose, component: _component, ...rest } = props;
  return {
    ...node,
    ...(renamed === undefined ? {} : { component: renamed }),
    props: rest as TreeNode["props"],
  };
};
