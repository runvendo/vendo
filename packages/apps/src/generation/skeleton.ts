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

/** The plan's layout as a tree, with every leaf still pending.
 *
 *  `from` shifts the group ordinals so an AMENDMENT's groups cannot claim an id
 *  the live app already mounted (see {@link growSkeleton}). It defaults to 0,
 *  which is the only value a fresh create ever uses. */
export const skeletonFromPlan = (plan: AppPlan, from = 0): Skeleton => {
  const tabs = planTabs(plan);
  const nodes: TreeNode[] = [];
  const slots: Record<string, string> = {};
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

/** The ordinal after the highest `group-N` the tree already carries — where an
 *  amendment's own groups start, so nothing already on the screen is renamed. */
const nextGroupOrdinal = (tree: Tree): number => {
  let highest = -1;
  for (const { id } of tree.nodes) {
    const match = /^group-(\d+)$/.exec(id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
};

/**
 * Grow a live app's layout by the groups an AMENDMENT planned. The existing
 * tree is untouched — ids, props, filled contents and all — so the screen keeps
 * what it has and only the new containers appear, shimmering, ready for their
 * workers. Ids are prefix-stable by construction: new groups start past the
 * highest ordinal in use, so no node the user is looking at is ever renamed.
 *
 * Where a group lands follows the app's own shape, and never invents a label:
 * a tab the app already has adopts the group; a NEW tab label becomes a new tab
 * beside the others (only when the app already has tab chrome to put it in);
 * and an app with no tabs at all takes the groups at its root, because giving
 * the existing content a tab name nobody wrote would be a guess.
 */
export const growSkeleton = (tree: Tree, plan: AppPlan): Skeleton => {
  const added = skeletonFromPlan(plan, nextGroupOrdinal(tree));
  const groupIds = Object.keys(added.slots);
  // The group subtrees only: the amendment's own app/tab chrome is scaffolding
  // for a tree that already exists.
  const chrome = new Set<string>([APP_ID, TAB_CHROME_ID]);
  for (const node of added.tree.nodes) {
    if (/^tab-\d+$/.test(node.id)) chrome.add(node.id);
  }
  const nodes: TreeNode[] = [
    ...tree.nodes.map((node) => ({ ...node })),
    ...added.tree.nodes.filter((node) => !chrome.has(node.id)),
  ];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const attach = (parentId: string, children: readonly string[]): void => {
    const parent = byId.get(parentId);
    if (parent === undefined || children.length === 0) return;
    parent.children = [...(parent.children ?? []), ...children];
  };

  const bar = byId.get(TAB_CHROME_ID);
  const existingTabs = bar === undefined
    ? []
    : ((bar.props?.tabs as ReadonlyArray<{ value?: unknown; label?: unknown }> | undefined) ?? [])
      .map(({ value }) => typeof value === "string" ? value : "");
  const panelOf = new Map(existingTabs.map((label, index) => [label, (bar?.children ?? [])[index] as string | undefined]));
  let nextPanel = (bar?.children ?? []).length;
  const nextTabs = [...existingTabs];

  for (const [position, group] of plan.groups.entries()) {
    const id = groupIds[position] as string;
    const label = group.tab;
    // A group the plan never labelled belongs to no tab — it stands at the
    // root, exactly where a fresh skeleton puts one.
    if (label === undefined || bar === undefined) {
      attach(tree.root, [id]);
      continue;
    }
    const panel = panelOf.get(label);
    if (panel !== undefined) {
      attach(panel, [id]);
      continue;
    }
    const panelId = `tab-${nextPanel}`;
    nextPanel += 1;
    nodes.push({ id: panelId, component: "Stack", source: "prewired", children: [id] });
    byId.set(panelId, nodes[nodes.length - 1] as TreeNode);
    panelOf.set(label, panelId);
    nextTabs.push(label);
    attach(TAB_CHROME_ID, [panelId]);
  }
  if (bar !== undefined && nextTabs.length > existingTabs.length) {
    bar.props = { ...bar.props, tabs: nextTabs.map((label) => ({ value: label, label })) };
  }

  const queries: TreeQuery[] = [...(tree.queries ?? [])];
  const declared = new Set(queries.map(({ name }) => name));
  for (const query of added.tree.queries ?? []) {
    if (declared.has(query.name)) continue;
    declared.add(query.name);
    queries.push(query);
  }
  return {
    tree: { ...tree, nodes, ...(queries.length === 0 ? {} : { queries }) },
    slots: added.slots,
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
 * `query` and `purpose` are the PLAN's vocabulary for describing a leaf, not
 * props any component takes — and a worker reading its own group's leaf list
 * routinely copies them onto the element it writes. The renderer drops them and
 * the checks report them, which is just noise about something no one can act on,
 * so they come off here.
 *
 * Only on nodes the worker itself invented: a `source: "host"` node names a real
 * host component, and a host is entitled to declare a prop called whatever it
 * likes — silently deleting one would be the worse bug.
 */
const withoutPlanVocabulary = (node: TreeNode): TreeNode["props"] => {
  if (node.source === "host" || node.props === undefined) return node.props;
  const { query: _query, purpose: _purpose, ...props } = node.props as Record<string, unknown>;
  return props as TreeNode["props"];
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
        ...(child.props === undefined ? {} : { props: withoutPlanVocabulary(child) }),
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
