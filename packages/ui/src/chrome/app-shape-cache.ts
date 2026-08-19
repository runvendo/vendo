/**
 * S2 — the pinned app's remembered silhouette.
 *
 * A slot repaints its skeleton on EVERY mount (use-app.ts refetches get+open
 * and the server re-runs the screen), so the wait is honest but shapeless: a
 * generic shimmer standing in front of an app the person has already seen.
 * This remembers what its BOXES look like — layout only, never a value — so the
 * next wait is drawn in the shape of the thing that is coming.
 *
 * Same storage manners as discoverability.ts and last-thread.ts: one `vendo:`
 * key per app, and degraded environments (SSR, sandboxed iframe, blocked or
 * full storage) read as "nothing remembered" while writes stay silent.
 */
import { sha256Hex, type TreeNode, type UIPayload } from "@vendoai/core";
import { deriveFormShape, type FormShape } from "../tree/forming-skeleton.js";

/** One bone. `line` is a kit VALUE (Text, a Link, an Icon) — one typographic line
 *  whatever the datum behind it; every other kind is deriveFormShape's own
 *  vocabulary, unchanged. */
export interface ShapeBox {
  kind: FormShape | "line";
}

/** What one app's key holds. `v` is the served tree's content hash, so an edit
 *  replaces the silhouette instead of outliving it. */
export interface AppShape {
  v: string;
  boxes: ShapeBox[];
}

const PREFIX = "vendo:app-shape:";
/** Which app a slot last held. The digest is keyed by APP id, but a cold
 *  revisit has to paint its skeleton BEFORE the placements read answers — at
 *  which point the slot does not yet know whose shape to draw. This is the way
 *  back. */
const SLOT_PREFIX = "vendo:app-slot:";
/** Enough bones to read as THIS app; past that a skeleton is just noise. */
const MAX_BOXES = 12;
/** Kit layout: no silhouette of its own — its children are the shape. */
const CONTAINERS = new Set(["Stack", "Row", "Grid", "Card", "Surface"]);
/** Kit values: whatever the datum, the bone is a line of text. */
const LINES = new Set(["Text", "Link", "Icon", "Divider"]);

function storage(): Storage | null {
  try {
    // The ACCESS itself can throw (sandboxed iframes, partitioned storage).
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(appId: string): AppShape | undefined {
  try {
    const stored = JSON.parse(storage()?.getItem(PREFIX + appId) ?? "null") as AppShape | null;
    return typeof stored?.v === "string" && Array.isArray(stored.boxes) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** The app's bones in render order. Containers are transparent; anything the
 *  kit does not name keeps the shape its NAME implies — the same read the
 *  streaming placeholder already makes of a component that has not landed. */
function boxesOf(nodes: TreeNode[], root: string): ShapeBox[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const boxes: ShapeBox[] = [];
  // A step budget rather than a visited set: this is wire data, and a child
  // cycle would otherwise hang the host page.
  let budget = MAX_BOXES * 20;
  const walk = (id: string): void => {
    const node = byId.get(id);
    if (node === undefined || boxes.length >= MAX_BOXES || --budget < 0) return;
    if (CONTAINERS.has(node.component)) {
      for (const child of node.children ?? []) walk(child);
      return;
    }
    boxes.push({ kind: LINES.has(node.component) ? "line" : deriveFormShape(node.component) });
  };
  walk(root);
  return boxes;
}

/** The remembered silhouette. Nothing stored, a record we cannot read, or an
 *  app with no bones all answer undefined — the slot falls back to the calm
 *  generic ghost. */
export function rememberedShape(appId: string): ShapeBox[] | undefined {
  const boxes = read(appId)?.boxes;
  return boxes !== undefined && boxes.length > 0 ? boxes : undefined;
}

/** The silhouette this SLOT last held — what it waits in while the placements
 *  read is still in flight and the app coming back is not named yet. Without one
 *  the slot falls back to the generic ghost; either way it must not paint the
 *  empty-slot invite, which is a claim about a slot nothing is pinned in. */
export function rememberedSlotShape(slotId: string): ShapeBox[] | undefined {
  try {
    const appId = storage()?.getItem(SLOT_PREFIX + slotId);
    return typeof appId === "string" ? rememberedShape(appId) : undefined;
  } catch {
    return undefined;
  }
}

/** Remember which app is in this slot. Best-effort, like every write here. */
export function rememberSlotApp(slotId: string, appId: string): void {
  try {
    storage()?.setItem(SLOT_PREFIX + slotId, appId);
  } catch {
    /* quota/denied — nothing to do */
  }
}

/** Remember what the served tree looks like. Only a tree surface has insides we
 *  can see, so an iframe-served app never reaches here and keeps the generic
 *  ghost forever. Best-effort, and a no-op when this version is already held. */
export function rememberShape(appId: string, payload: UIPayload): void {
  const { nodes, root } = payload as { nodes?: unknown; root?: unknown };
  if (!Array.isArray(nodes) || typeof root !== "string") return;
  const tree = nodes as TreeNode[];
  const v = sha256Hex(tree.map(node => `${node.id}:${node.component}`).join("\n"));
  if (read(appId)?.v === v) return;
  try {
    storage()?.setItem(PREFIX + appId, JSON.stringify({ v, boxes: boxesOf(tree, root) } satisfies AppShape));
  } catch {
    /* quota/denied — nothing to do */
  }
}
