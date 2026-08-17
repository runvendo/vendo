import {
  isPlainObject,
  VENDO_TREE_FORMAT,
  type AppId,
  type Json,
  type UIPayload,
} from "@vendoai/core";

/**
 * The GEOMETRY a half-built app may show: node ids, component names, nesting,
 * and the `streaming` tag that holds the renderer on the forming silhouette
 * instead of reaching a verdict (renderer.tsx).
 *
 * Everything a figure could ride is dropped, because a draft's figures are the
 * ones the build is about to correct. `props` goes because it is where a painted
 * screen keeps its numbers; `data` because it is the resolved query results those
 * numbers came from; `interactive` and `components` because they are executable
 * halves that would re-render the draft live in the browser. What is left cannot
 * express a number — a whitelist, never a redaction.
 *
 * Two ids do travel: `root` and each node's own. They are never rendered as text,
 * and keeping them is what lets the silhouette MORPH into the finished app
 * instead of remounting it, so they stay — noting that an author who wrote
 * `key={tx.amount}` would put a figure inside an id it never displays.
 *
 * Shape-checked rather than cast, and it cannot throw: a payload that is
 * differently tagged or malformed simply yields no geometry, which is the
 * contract's ordinary "not paintable yet" and the embed's beat bar.
 */
const structuralOnly = (payload: UIPayload): UIPayload | undefined => {
  if (payload.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  if (typeof payload.root !== "string" || !Array.isArray(payload.nodes)) return undefined;
  const nodes = payload.nodes.flatMap((node) => {
    if (!isPlainObject(node) || typeof node["id"] !== "string" || typeof node["component"] !== "string") return [];
    const children = node["children"];
    return [{
      id: node["id"],
      component: node["component"],
      ...(Array.isArray(children) ? { children: structuredClone(children) as Json } : {}),
    }];
  });
  return nodes.length === 0
    ? undefined
    : { formatVersion: VENDO_TREE_FORMAT, root: payload.root, nodes, streaming: true };
};

/**
 * The shape of each in-flight build's LAST paint, kept only in this process's
 * memory.
 *
 * A code-first build already renders its half-written screen on every landed
 * `app.tsx` commit, to decide whether anything may paint at all
 * (generation/render-seam.ts). That render is the only place a growing app has a
 * silhouette — an app IS its `app.tsx`, and its tree is what RENDERING that
 * produces — so this parks the geometry the build already paid for where the
 * embed's pending poll can read it. A poll still costs no render.
 *
 * EPHEMERAL by construction, and that is the point: no document keeps a tree, so
 * there is nothing here that can outlive the build, disagree with the app, or be
 * mistaken for what the app is. A restart, or a poll served by another process,
 * simply finds nothing and the embed reads its beat bar — the behaviour that
 * shipped before this existed.
 *
 * Bounded rather than swept: entries are small, geometry-only, and the oldest
 * goes when the map is full, so a long-lived deployment cannot grow one. An entry
 * that outlives its build is never served — `createAppOpener` reads this only
 * while `building` is in flight — and if that app is edited later, its previous
 * shape is exactly what should be on screen while the new one forms.
 */
const forming = new Map<AppId, UIPayload>();

const FORMING_LIMIT = 256;

/** Park what this paint looks like. Anything that could carry a figure is gone
 *  before the payload reaches the map, so no figure is ever held for a poll. */
export const recordForming = (appId: AppId, payload: UIPayload): void => {
  const shape = structuralOnly(payload);
  if (shape === undefined) return;
  forming.set(appId, shape);
  if (forming.size > FORMING_LIMIT) forming.delete(forming.keys().next().value as AppId);
};

/** The geometry this app last painted, or undefined if it has not painted in
 *  this process. */
export const formingTreeOf = (appId: AppId): UIPayload | undefined => forming.get(appId);
