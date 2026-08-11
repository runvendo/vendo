/**
 * The nested paint, flattened into addressable nodes.
 *
 * A renderer wants two things the nested tree cannot give it: a name for every
 * node it can hold onto, and a way to reach one node without walking to it. An
 * id from the STRUCTURAL PATH gives both — and because the path uses the
 * component's `key` wherever it wrote one, the id of a row survives a repaint
 * that inserts a row above it. Downstream that id becomes the React key, so
 * state inside the rendered kit (an open menu, a focused input, a scroll
 * position) survives the repaint too. An id built from a running counter would
 * not: every row below the insert would be renamed and remounted.
 *
 * The format reads as the walk that produced it — `root.0.Card:tr_129.1`.
 *
 * The VM's handler ids are minted against the SAME path (plus the prop name),
 * so a node's id and the ids of its handlers agree by construction.
 *
 * THE ONE CAVEAT, and the reason a key is worth writing: a position is a
 * position. A keyless sibling that appears — the `{error && <Banner/>}` above a
 * list — renumbers every keyless sibling after it, so those ids change and the
 * kit remounts them. React has the same property, which is why keys exist;
 * anything conditional or repeated wants one.
 */
import { SCREEN_TEXT_NODE, type FlatNode, type FlatTree, type NestedNode } from "./types.js";

/** The id of the node a screen paints into. */
const ROOT = "root";

/** One child's path segment: its key when it has one, its position when it
 *  does not. The component name rides along with the key so two lists that
 *  reuse an id (`"1"`) in the same parent still read apart. */
const segment = (child: NestedNode | string, index: number): string =>
  typeof child === "string" || child.key === undefined ? String(index) : `${child.component}:${child.key}`;

/**
 * Flatten one paint. Total and pure: every node in, every node out, ids
 * deterministic for an unchanged position.
 *
 * A text child becomes a node of its own — component {@link SCREEN_TEXT_NODE},
 * its text in `props.text` — so `children` is unambiguously a list of ids and a
 * renderer never has to guess whether `"root"` is an id or the word.
 *
 * Two siblings written with the SAME key would claim one id (React warns about
 * exactly this); the second and later take a `~2` suffix rather than
 * overwriting the first, so a duplicate key costs stability, never a node.
 */
export function flattenTree(root: NestedNode): FlatTree {
  const nodes: Record<string, FlatNode> = {};
  const claimed = new Set<string>([ROOT]);

  const claim = (base: string): string => {
    if (!claimed.has(base)) {
      claimed.add(base);
      return base;
    }
    let taken = 2;
    while (claimed.has(`${base}~${taken}`)) taken += 1;
    const id = `${base}~${taken}`;
    claimed.add(id);
    return id;
  };

  const walk = (node: NestedNode, id: string): void => {
    const children: string[] = [];
    node.children.forEach((child, index) => {
      const childId = claim(`${id}.${segment(child, index)}`);
      children.push(childId);
      if (typeof child === "string") {
        nodes[childId] = { id: childId, component: SCREEN_TEXT_NODE, props: { text: child }, children: [] };
      } else {
        walk(child, childId);
      }
    });
    nodes[id] = { id, component: node.component, props: node.props, children };
  };

  walk(root, ROOT);
  return { nodes, root: ROOT };
}
