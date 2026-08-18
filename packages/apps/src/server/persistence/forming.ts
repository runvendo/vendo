import {
  isPlainObject,
  VENDO_TREE_FORMAT,
  type AppId,
  type UIPayload,
} from "@vendoai/core";

/**
 * The geometry of one paint — node ids, component names, nesting, and the
 * `streaming` tag that holds the renderer on the silhouette (renderer.tsx).
 * A whitelist, never a redaction: what is left cannot express a number.
 *
 * An id is structural EXCEPT where the author wrote a `key`, which `flatten.ts`
 * spells into it (`Row:tr_129`) and which can be the very thing that may not
 * travel — `key={bill.amount_cents}` is a figure, `key={user.email}` an address.
 * The key is replaced by a counter, so nothing of the value survives, not even a
 * hash of it. Keyed nodes pay a remount instead of a morph; a figure is not
 * payable at all.
 *
 * Shape-checked rather than cast, and it cannot throw: a malformed or
 * differently tagged payload simply yields no geometry, which is the contract's
 * ordinary "not paintable yet".
 */
const structuralOnly = (payload: UIPayload): UIPayload | undefined => {
  if (payload.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  if (typeof payload.root !== "string" || !Array.isArray(payload.nodes)) return undefined;
  const safe = new Map<string, string>();
  const anonymize = (id: string): string => {
    const known = safe.get(id);
    if (known !== undefined) return known;
    const key = id.indexOf(":");
    const stripped = key === -1 ? id : `${id.slice(0, key)}:${safe.size}`;
    safe.set(id, stripped);
    return stripped;
  };
  const nodes = payload.nodes.flatMap((node) => {
    if (!isPlainObject(node) || typeof node["id"] !== "string" || typeof node["component"] !== "string") return [];
    const children = node["children"];
    return [{
      id: anonymize(node["id"]),
      component: node["component"],
      ...(Array.isArray(children)
        ? { children: children.filter((child): child is string => typeof child === "string").map(anonymize) }
        : {}),
    }];
  });
  return nodes.length === 0
    ? undefined
    : { formatVersion: VENDO_TREE_FORMAT, root: anonymize(payload.root), nodes, streaming: true };
};

/**
 * The shape of each in-flight build's last paint, in this process's memory
 * alone.
 *
 * A code-first build already renders its half-written `app.tsx` on every landed
 * commit, to decide whether anything may paint at all (generation/render-seam.ts).
 * This parks the geometry that render already paid for where the pending poll can
 * read it, so a poll still costs no render. A restart, or a poll served by another
 * process, finds nothing and the embed reads its beat bar.
 */
const forming = new Map<AppId, UIPayload>();

const FORMING_LIMIT = 256;

/** Park what this paint looks like. Re-inserted rather than overwritten, because
 *  `set` on a live key does not reorder: without the delete the entry evicted is
 *  the first build to start, which on a busy process is the one still running. */
export const recordForming = (appId: AppId, payload: UIPayload): void => {
  const shape = structuralOnly(payload);
  if (shape === undefined) return;
  forming.delete(appId);
  forming.set(appId, shape);
  if (forming.size > FORMING_LIMIT) forming.delete(forming.keys().next().value as AppId);
};

/** The geometry this app last painted, or undefined if it has not painted in
 *  this process. */
export const formingTreeOf = (appId: AppId): UIPayload | undefined => forming.get(appId);
