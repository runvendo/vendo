import type { Json, Tree, TreeNode, TreeQuery } from "@vendoai/core";

/**
 * Build a synthetic vendo-genui/v1 tree of exactly `nodeCount` nodes with
 * realistic props, $path / $state bindings, and up to 16 queries (the 01 §8
 * cap). Prewired primitives only, so it validates and server-renders without
 * the jail. Never exceeds `nodeCount` (5000 is the contract maximum).
 */
export function syntheticTree(nodeCount: number): Tree {
  const nodes: TreeNode[] = [];
  const rootChildren: string[] = [];
  nodes.push({ id: "root", component: "Stack", source: "prewired", children: rootChildren });

  const rows: Json[] = [];
  const data: Record<string, Json> = { rows, title: "Synthetic dashboard", count: 0 };

  const remaining = (): number => nodeCount - nodes.length;
  let section = 0;

  while (remaining() >= 2) {
    const sectionId = `section_${section}`;
    const sectionChildren: string[] = [];
    nodes.push({ id: sectionId, component: "Surface", source: "prewired", children: sectionChildren });
    rootChildren.push(sectionId);

    const headerId = `${sectionId}_header`;
    nodes.push({
      id: headerId,
      component: "Text",
      source: "prewired",
      props: { text: { $path: "/title" }, weight: "bold" },
    });
    sectionChildren.push(headerId);

    let cell = 0;
    while (remaining() >= 3 && cell < 24) {
      const index = rows.length;
      rows.push({ name: `Row ${index}`, total: index * 7, active: index % 2 === 0 });
      const rowId = `${sectionId}_row_${cell}`;
      nodes.push({ id: rowId, component: "Row", source: "prewired", children: [`${rowId}_name`, `${rowId}_total`] });
      nodes.push({
        id: `${rowId}_name`,
        component: "Text",
        source: "prewired",
        props: { text: { $path: `/rows/${index}/name` }, muted: { $state: "dense" } },
      });
      nodes.push({
        id: `${rowId}_total`,
        component: "Text",
        source: "prewired",
        props: { text: { $path: `/rows/${index}/total` } },
      });
      sectionChildren.push(rowId);
      cell += 1;
    }
    section += 1;
  }

  // Pad any leftover slot (0 or 1) with a plain Text leaf so counts land exactly.
  while (remaining() > 0) {
    const id = `pad_${nodes.length}`;
    nodes.push({ id, component: "Text", source: "prewired", props: { text: "." } });
    rootChildren.push(id);
  }

  data.count = rows.length;

  const queries: TreeQuery[] = [];
  for (let i = 0; i < Math.min(16, section); i += 1) {
    queries.push({ path: `/rows/${i}`, tool: "host_items_list", input: { section: i } });
  }

  return { formatVersion: "vendo-genui/v1", root: "root", nodes, data, queries };
}

/** The node sizes the deterministic tree suites sweep. 5000 = the 01 §8 cap. */
export const TREE_SIZES = [10, 100, 1000, 5000] as const;
