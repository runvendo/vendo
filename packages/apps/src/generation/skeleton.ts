/**
 * The deterministic skeleton (generation pipeline rebuild, Task 5;
 * docs/superpowers/plans/2026-07-28-generation-pipeline-rebuild.md).
 *
 * A plan is not a preview — it IS the app's layout. The moment the brain's
 * plan lands, this turns it into the real tree: tab chrome derived from the
 * group labels, one titled surface per group, and one placeholder per leaf
 * that shimmers until a fill worker writes the real thing into its slot.
 * Nothing here calls a model; the same plan always yields the same tree.
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
  /** Group id → the node whose children a fill fragment replaces. Group ids are
   *  positional (`group-{index in plan.groups}`) and the keys are in plan
   *  order, so a fill worker for `plan.groups[i]` splices into
   *  `slots[`group-${i}`]`. */
  slots: Record<string, string>;
}

const APP_ID = "app";
const TAB_CHROME_ID = "tabs";
const groupId = (index: number): string => `group-${index}`;
const tabPanelId = (index: number): string => `tab-${index}`;

/** The plan's layout as a tree, with every leaf still pending. */
export const skeletonFromPlan = (plan: AppPlan): Skeleton => {
  const tabs = planTabs(plan);
  const nodes: TreeNode[] = [];
  const slots: Record<string, string> = {};
  const groupIdsWithTab = (tab: string | undefined): string[] =>
    plan.groups.flatMap((group, index) => (group.tab === tab ? [groupId(index)] : []));

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
    // tree/branded.tsx Tabs), so switching tabs never leaves the browser.
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

  for (const [index, group] of plan.groups.entries()) {
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
    // The slot container survives the fill (the worker writes its CHILDREN), so
    // a grid group's column count is decided here: one column per leaf, capped
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
    slots[id] = slot;
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
    slots,
  };
};

/** Every id reachable from `roots`, the roots included. */
const subtree = (byId: ReadonlyMap<string, TreeNode>, roots: readonly string[]): Set<string> => {
  const found = new Set<string>(roots);
  const queue = [...roots];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of byId.get(queue[cursor] as string)?.children ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
};

/**
 * One fill worker's fragment, spliced into one group's slot: the slot container
 * survives (the plan decided its layout), its pending placeholders are gone,
 * and the fragment's own nodes become its children. Pure — the tree handed in
 * is never touched.
 *
 * Fragment ids are namespaced by the slot they land in. Every worker compiles
 * its fragment alone and mints from zero, so two of them would otherwise both
 * claim `stat-1`; the prefix also means re-filling ONE group renames nothing
 * outside it.
 */
export const spliceFragment = (tree: Tree, slotNodeId: string, fragment: Tree): Tree => {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const slot = byId.get(slotNodeId);
  if (slot === undefined) return tree;
  const stale = subtree(byId, slot.children ?? []);
  const namespaced = (id: string): string => `${slotNodeId}-${id}`;
  const landing = fragment.nodes.filter((node) => node.id !== fragment.root);
  const nodes = tree.nodes.flatMap((node) => {
    if (stale.has(node.id)) return [];
    if (node.id !== slotNodeId) return [node];
    const children = fragment.nodes
      .find((candidate) => candidate.id === fragment.root)?.children ?? [];
    return [
      { ...node, children: children.map(namespaced) },
      ...landing.map((child) => ({
        ...child,
        id: namespaced(child.id),
        ...(child.children === undefined ? {} : { children: child.children.map(namespaced) }),
      })),
    ];
  });
  // Workers bind to the queries the plan declared, but a fragment may mint one
  // of its own from an inline tool reference — it rides along so its bindings
  // resolve. A name already declared keeps its original definition: two groups
  // minting the same name mean the same read, and the plan's own declaration
  // always outranks a worker's.
  const declared = new Set((tree.queries ?? []).map((query) => query.name));
  const queries = [
    ...(tree.queries ?? []),
    ...(fragment.queries ?? []).filter((query) => !declared.has(query.name)),
  ];
  return { ...tree, nodes, ...(queries.length === 0 ? {} : { queries }) };
};
