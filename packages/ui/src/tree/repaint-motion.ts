/**
 * The animated landing: when a handler's refresh repaints an already-painted
 * screen, the CHANGE is shown rather than swapped.
 *
 * A repaint arrives as a whole new flat tree, but the node ids are structural
 * paths (apps/contract/genui/component/flatten.ts) and they are already this
 * renderer's React keys — so React has mounted, updated and unmounted the right
 * elements before we get here. All that is missing is the beat that says which:
 * a row that arrived slides open under a fading highlight, a row that left
 * collapses out, and a value that moved pulses (and, for the Kit's numeric
 * leaves, rolls to its new figure).
 *
 * Three rules the shape encodes:
 *
 *  1. Only repaints animate. The first paint, every streaming chunk and the
 *     forming-skeleton reveal (fluid-reveal.tsx) are somebody else's beat — the
 *     baseline resets whenever motion is off, so the first paint AFTER a stream
 *     is still a first paint.
 *  2. Nothing ambiguous animates. A keyless sibling's id is its POSITION, so
 *     deleting the middle row of an unkeyed list renames every row below it and
 *     the diff reads "the LAST row left". That would collapse the wrong row, so
 *     when the ids of a changed list are positional AND its survivors' contents
 *     shifted, the whole list swaps instantly instead. A missing animation reads
 *     fine; a wrong one reads broken.
 *  3. One beat, not fireworks. Past {@link MAX_MARKS} changed nodes the repaint
 *     is a different view rather than a data refresh, and nothing animates.
 */
import { isHandlerRef, SCREEN_TEXT_NODE } from "@vendoai/apps/contract";
import type { TreeNode } from "@vendoai/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyFormat } from "../kit/format.js";
import { t } from "../kit/tokens.js";

export type NodeMap = ReadonlyMap<string, TreeNode>;

/** A value that rolls from one figure to the next rather than cutting to it. */
export interface NumericTick {
  from: number;
  to: number;
  /** The exact string the leaf renders for a value — the tick writes these. */
  render(value: number): string | null;
}

export type NodeMark =
  | { kind: "enter" }
  | { kind: "exit" }
  | { kind: "pulse"; tick: NumericTick | null };

export interface PaintDiff {
  marks: ReadonlyMap<string, NodeMark>;
  /** Departed subtrees, with the surviving parent and slot they held. */
  exits: ReadonlyArray<{ parent: string; index: number; id: string }>;
}

const EMPTY_DIFF: PaintDiff = { marks: new Map(), exits: [] };

/** Past this many changed nodes a repaint is a new view, not a refresh. */
const MAX_MARKS = 24;

/**
 * The Kit's numeric leaves: the leaf that holds a number, and how it prints one.
 * Everything else pulses without rolling — a date or a status has no in-between
 * to show.
 *
 * A `Stat` handed an already-formatted string — the common shape now that a
 * screen formats with `Intl` in its own code — CUTS to its new text instead,
 * which is accepted: only a number has an in-between to roll through.
 */
const NUMERIC_LEAVES: Record<string, NumericTick["render"]> = {
  Stat: (value) => applyFormat(value, "text"),
};

/** The numeric prop of a Kit numeric leaf, when it holds a finite number. */
const numericValue = (node: TreeNode): number | undefined => {
  if (!(node.component in NUMERIC_LEAVES)) return undefined;
  const raw = node.props?.value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
};

const tickBetween = (before: TreeNode, after: TreeNode): NumericTick | null => {
  const from = numericValue(before);
  const to = numericValue(after);
  if (from === undefined || to === undefined || from === to) return null;
  const render = NUMERIC_LEAVES[after.component];
  // A leaf that cannot print its own value has nothing to roll THROUGH, so it
  // takes the pulse alone.
  return render && render(to) !== null ? { from, to, render } : null;
};

const parentsOf = (map: NodeMap): Map<string, string> => {
  const parents = new Map<string, string>();
  for (const node of map.values()) for (const child of node.children ?? []) parents.set(child, node.id);
  return parents;
};

/**
 * What a leaf SHOWS: its own props plus the text its text-children hold. Key
 * order is the VM's own and stable across its paints.
 *
 * `{$handler}` props are machinery, not a value — and their ids are minted
 * against the node's POSITION, so every row below a deleted one gets a new
 * handler id and would pulse for a value that never moved.
 */
const contentOf = (node: TreeNode, map: NodeMap): string => JSON.stringify([
  Object.entries(node.props ?? {}).filter(([, value]) => !isHandlerRef(value)),
  (node.children ?? []).map((id) => map.get(id)?.props?.text ?? null),
]);

/** A node whose children are all runs of text — the deepest thing that owns a
 *  displayed value. A container never pulses: its card is not what changed. */
const isLeaf = (node: TreeNode, map: NodeMap): boolean =>
  (node.children ?? []).every((id) => map.get(id)?.component === SCREEN_TEXT_NODE);

/** Does an author key name this node, or only its position? */
const isKeyed = (id: string): boolean => id.slice(id.lastIndexOf(".") + 1).includes(":");

const descends = (id: string, ancestor: string, parents: Map<string, string>): boolean => {
  let walk = parents.get(id);
  while (walk !== undefined) {
    if (walk === ancestor) return true;
    walk = parents.get(walk);
  }
  return false;
};

/** What moved between two paints of the same screen. Pure. */
export function diffPaints(before: NodeMap, after: NodeMap): PaintDiff {
  const wasParent = parentsOf(before);
  const isParent = parentsOf(after);

  // Only the TOPMOST arrival/departure animates: a row that slid in does not
  // also need each of its cells to slide in.
  const entered = [...after.keys()]
    .filter((id) => !before.has(id) && before.has(isParent.get(id) ?? ""));
  const exited = [...before.keys()]
    .filter((id) => !after.has(id) && after.has(wasParent.get(id) ?? ""));
  const pulsed = [...after.keys()].filter((id) => {
    const now = after.get(id)!;
    const then = before.get(id);
    return then !== undefined && isLeaf(now, after) && contentOf(then, before) !== contentOf(now, after);
  });

  // Rule 2 — a keyed id names a thing, so its arrival IS an arrival. A
  // POSITIONAL one only names a slot: if a list's positional survivors are
  // showing different contents, the ids renumbered and the diff is reading the
  // wrong row. Drop that list's positional marks; its keyed siblings are
  // unaffected, and so is the rest of the screen.
  const suppressed = new Set<string>();
  for (const parent of new Set([...entered.map((id) => isParent.get(id)!), ...exited.map((id) => wasParent.get(id)!)])) {
    const slots = [...entered, ...exited]
      .filter((id) => (isParent.get(id) ?? wasParent.get(id)) === parent && !isKeyed(id));
    if (slots.length === 0) continue;
    const held = (after.get(parent)?.children ?? []).filter((id) => before.has(id) && !isKeyed(id));
    const shifted = pulsed.filter((leaf) => held.some((slot) => slot === leaf || descends(leaf, slot, isParent)));
    if (shifted.length === 0) continue;
    for (const id of [...slots, ...shifted]) suppressed.add(id);
  }

  const marks = new Map<string, NodeMark>();
  for (const id of entered) if (!suppressed.has(id)) marks.set(id, { kind: "enter" });
  for (const id of exited) if (!suppressed.has(id)) marks.set(id, { kind: "exit" });
  for (const id of pulsed) {
    if (!suppressed.has(id)) marks.set(id, { kind: "pulse", tick: tickBetween(before.get(id)!, after.get(id)!) });
  }
  if (marks.size === 0 || marks.size > MAX_MARKS) return EMPTY_DIFF;

  const exits = exited
    .filter((id) => marks.has(id))
    .map((id) => {
      const parent = wasParent.get(id)!;
      return { parent, index: (before.get(parent)?.children ?? []).indexOf(id), id };
    });
  return { marks, exits };
}

/** Copy a departed subtree out of the paint it belonged to. */
const carryOver = (from: NodeMap, id: string, into: Map<string, TreeNode>): void => {
  const node = from.get(id);
  if (node === undefined || into.has(id)) return;
  into.set(id, node);
  for (const child of node.children ?? []) carryOver(from, child, into);
};

/** Held one beat past the repaint, so departing rows have something to leave. */
const EXIT_HOLD_MS = 360;

/**
 * Reduced motion means an INSTANT swap, not a slower one — and an environment
 * with no Web Animations (SSR, jsdom) is in exactly the same position: holding a
 * departed row for a beat it cannot animate out just leaves a corpse on screen.
 * Either way the repaint lands the way it always did.
 */
const motionAllowed = (): boolean =>
  typeof window !== "undefined"
  && typeof Element.prototype.animate === "function"
  && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== true;

/** The beat has to be set up BEFORE the browser paints the repaint, or an
 *  entering row flashes at full height for a frame. On the server there is no
 *  paint (and no marks), so the layout variant would only earn a warning. */
export const useMotionLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/**
 * The renderer's seam. Returns the node map to WALK — the repaint's own, plus
 * any departing subtrees spliced back into the slots they held — and the mark
 * each node's shell should play.
 *
 * `active` is the caller's "this is a repaint of a live screen" gate; while it
 * is false the baseline resets, so the paint that turns it back on is treated
 * as a first paint rather than a diff against a stream.
 */
export function useRepaintMotion(nodes: NodeMap, active: boolean): { nodes: NodeMap; marks: ReadonlyMap<string, NodeMark> } {
  const previous = useRef<NodeMap | null>(null);
  const [beat, setBeat] = useState<{ diff: PaintDiff; before: NodeMap } | null>(null);

  // Render-phase capture, as FluidReveal does it: the paint has to be diffed on
  // the render that carries it, or the tree it replaced is already gone.
  if (!active || !motionAllowed()) previous.current = null;
  else if (previous.current !== nodes) {
    const before = previous.current;
    previous.current = nodes;
    if (before !== null) {
      const diff = diffPaints(before, nodes);
      if (diff.marks.size > 0) setBeat({ diff, before });
    }
  }

  useEffect(() => {
    if (beat === null) return undefined;
    const timer = setTimeout(() => setBeat(null), EXIT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [beat]);

  const walked = useMemo(() => {
    if (beat === null || beat.diff.exits.length === 0) return nodes;
    const merged = new Map(nodes);
    for (const exit of beat.diff.exits) carryOver(beat.before, exit.id, merged);
    for (const parent of new Set(beat.diff.exits.map((exit) => exit.parent))) {
      const node = merged.get(parent);
      if (node === undefined) continue;
      const children = [...(node.children ?? [])];
      for (const exit of beat.diff.exits.filter((one) => one.parent === parent).sort((a, b) => a.index - b.index)) {
        children.splice(Math.min(Math.max(exit.index, 0), children.length), 0, exit.id);
      }
      merged.set(parent, { ...node, children });
    }
    return merged;
  }, [nodes, beat]);

  return { nodes: walked, marks: beat?.diff.marks ?? EMPTY_DIFF.marks };
}

// ── The motion itself ───────────────────────────────────────────────────────
// Transform/opacity carry the beat; the collapse animates height because that
// is what closes the gap a departing row leaves — the rows below it ride the
// same 280ms rather than needing a second animation of their own.

const ENTER_MS = 340;
const EXIT_MS = 280;
const HIGHLIGHT_MS = 800;
const PULSE_MS = 520;
const TICK_MS = 600;
/** Strong ease-out: entrances and exits both answer the user immediately. */
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

const TINT = `color-mix(in srgb, ${t.accent} 9%, transparent)`;
const RING = `color-mix(in srgb, ${t.accent} 26%, transparent)`;

/**
 * The highlight: a brand-tinted wash that holds a third of a beat, then fades.
 *
 * It borrows the radius of whatever it wraps so it hugs a card's corners
 * instead of boxing them, and falls back to a soft 6px for a bare run of text —
 * a square-cornered tint on a number reads as a text SELECTION, not a change.
 * An arriving row earns a hairline ring to define it; a value that merely moved
 * gets the wash alone, spread a few pixels past the glyphs.
 */
function highlight(el: HTMLElement, duration: number, ring: boolean): void {
  const inner = el.firstElementChild;
  const radius = inner === null ? "" : getComputedStyle(inner).borderRadius;
  el.style.borderRadius = radius && radius !== "0px" ? radius : "6px";
  const lit = {
    backgroundColor: TINT,
    boxShadow: ring ? `0 0 0 1px ${RING}, 0 10px 30px -12px ${RING}` : `0 0 0 4px ${TINT}`,
  };
  const dark = { backgroundColor: "transparent", boxShadow: ring ? "0 0 0 1px transparent, 0 10px 30px -12px transparent" : "0 0 0 4px transparent" };
  const animation = el.animate(
    [{ ...lit, offset: 0 }, { ...lit, offset: 0.3 }, { ...dark, offset: 1 }],
    { duration, easing: "ease-out" },
  );
  void animation.finished.then(() => { el.style.borderRadius = ""; }, () => undefined);
}

/** The gap a stacking parent puts between its children. A row on its way out
 *  has to give that back too, or the list closes 14px short and jumps when the
 *  departing box finally unmounts. */
const stackGap = (el: HTMLElement): string => {
  const parent = el.parentElement;
  const gap = parent === null ? Number.NaN : Number.parseFloat(getComputedStyle(parent).rowGap);
  return Number.isFinite(gap) && gap > 0 ? `${-gap}px` : "0px";
};

/** Roll a leaf's rendered figure to its new value. The text node is found by the
 *  string React just wrote, so a leaf we cannot identify is simply left alone. */
function roll(el: HTMLElement, tick: NumericTick): void {
  const settled = tick.render(tick.to);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let target: Text | null = null;
  for (let node = walker.nextNode(); node !== null && target === null; node = walker.nextNode()) {
    if (node.nodeValue === settled) target = node as Text;
  }
  if (target === null) return;
  const started = performance.now();
  const step = (now: number): void => {
    // Clamped at BOTH ends: rAF reports the frame's START time, which can
    // predate the layout effect that scheduled it — an unclamped negative
    // progress makes the first figure overshoot past where it began.
    const progress = Math.min(1, Math.max(0, (now - started) / TICK_MS));
    const eased = 1 - (1 - progress) ** 3;
    target.nodeValue = progress === 1 ? settled : tick.render(tick.from + (tick.to - tick.from) * eased) ?? settled;
    if (progress < 1) requestAnimationFrame(step);
  };
  // The old figure goes back BEFORE the browser paints the repaint, or the
  // value flashes its new number for one frame and then rewinds to roll.
  step(started);
  requestAnimationFrame(step);
}

/** Play a node's mark on its shell element. Safe to call with no Web Animations
 *  support (jsdom, older engines): the beat is skipped, the paint still lands. */
export function playNodeMotion(el: HTMLElement, mark: NodeMark): void {
  if (typeof el.animate !== "function") return;
  if (mark.kind === "pulse") {
    highlight(el, PULSE_MS, false);
    if (mark.tick !== null) roll(el, mark.tick);
    return;
  }
  const height = `${el.getBoundingClientRect().height}px`;
  const closed = { height: "0px", opacity: 0, marginBottom: stackGap(el) };
  const open = { height, opacity: 1, marginBottom: "0px", transform: "none" };
  el.style.overflow = "hidden";
  if (mark.kind === "exit") {
    // A row on its way out must not take a click with it.
    el.style.pointerEvents = "none";
    el.animate([{ ...open }, { ...closed, transform: "translateY(-4px)" }], { duration: EXIT_MS, easing: EASE, fill: "forwards" });
    return;
  }
  const opening = el.animate(
    [{ ...closed, transform: "translateY(-6px)" }, { ...open }],
    { duration: ENTER_MS, easing: EASE },
  );
  void opening.finished.then(() => { el.style.overflow = ""; }, () => undefined);
  highlight(el, HIGHLIGHT_MS, true);
}
