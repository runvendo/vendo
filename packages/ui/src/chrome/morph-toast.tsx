import type { VendoTheme } from "@vendoai/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { themeCssVariables } from "../theme.js";

/**
 * The approval→notification morph: the decided panel lifts out of the thread
 * and settles into the top-right notification. The travel is a GPU transform
 * and the size eases on a spring curve, so nothing layout-thrashes. The
 * surface is the same solid glass as the overlay (not a translucent liquid
 * blob), and it's inset from the corner so it's never clipped.
 *
 * Lane pick 4-C — the morph teaches the record: when an Activity anchor is
 * mounted (an element carrying `data-vendo-activity-anchor`, e.g. the
 * VendoPage Activity tab), the settled pill holds briefly and then shrinks
 * and docks INTO the anchor instead of fading in place, dispatching a
 * `vendo:activity-bump` event as it lands so the anchor can pulse. Without
 * an anchor (overlay/threads outside the page) the original hold-and-fade
 * behavior is unchanged. Reduced motion keeps the opacity-only exit.
 */
export interface MorphToastProps {
  startRect: { top: number; left: number; width: number; height: number };
  title: string;
  sub?: string;
  logoUrl?: string;
  theme: VendoTheme;
  holdMs?: number;
  /** Override the dock target lookup (default: the `data-vendo-activity-anchor`
      element). Return undefined to fade in place. */
  dockTo?(): { top: number; left: number; width: number; height: number } | undefined;
  onDone(): void;
}

const PILL = { width: 356, height: 62 };
const MARGIN = 18;
/** Docked size while the pill is absorbed into the anchor. */
const DOCK = { width: 40, height: 26 };
const FADE_HOLD_MS = 3200;
const DOCK_HOLD_MS = 1400;
const DOCK_MS = 500;
const DOCK_BUMP_AT_MS = 480;

export const ACTIVITY_ANCHOR_ATTRIBUTE = "data-vendo-activity-anchor";
/** Fired on window as the morph pill lands in the Activity anchor. */
export const ACTIVITY_BUMP_EVENT = "vendo:activity-bump";

function activityAnchorRect(): { top: number; left: number; width: number; height: number } | undefined {
  const anchor = document.querySelector(`[${ACTIVITY_ANCHOR_ATTRIBUTE}]`);
  if (!anchor) return undefined;
  const rect = anchor.getBoundingClientRect();
  return rect.width > 0 ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : undefined;
}

export function MorphToast({ startRect, title, sub, logoUrl, theme, holdMs, dockTo, onDone }: MorphToastProps) {
  const [settled, setSettled] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dock, setDock] = useState<{ x: number; y: number } | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const dockToRef = useRef(dockTo);
  dockToRef.current = dockTo;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    const travel = reduced ? 0 : 640;
    // Whether this morph docks is decided when the hold elapses (the anchor's
    // rect is read fresh then), but the hold LENGTH needs a decision up front:
    // probe once — a page whose anchor mounts mid-hold simply fades this time.
    const willDock = !reduced
      && typeof document !== "undefined"
      && (dockToRef.current ? dockToRef.current() !== undefined : activityAnchorRect() !== undefined);
    const hold = holdMs ?? (willDock ? DOCK_HOLD_MS : FADE_HOLD_MS);
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => {
      const rect = reduced ? undefined : (dockToRef.current ? dockToRef.current() : activityAnchorRect());
      if (rect) {
        setDock({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        timers.push(setTimeout(() => {
          window.dispatchEvent(new CustomEvent(ACTIVITY_BUMP_EVENT));
        }, DOCK_BUMP_AT_MS));
        timers.push(setTimeout(() => doneRef.current(), DOCK_MS + 200));
      } else {
        setLeaving(true);
        timers.push(setTimeout(() => doneRef.current(), 460));
      }
    }, travel + hold));
    return () => {
      cancelAnimationFrame(raf);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [holdMs, reduced]);

  if (typeof window === "undefined" || typeof document === "undefined") return null;

  const targetLeft = window.innerWidth - PILL.width - MARGIN;
  const spring = "cubic-bezier(.34,1.28,.42,1)";
  const sink = "cubic-bezier(.5,0,.8,.4)";

  const docking = dock !== null;
  const dx = docking ? dock.x - DOCK.width / 2 - startRect.left
    : settled ? targetLeft - startRect.left : 0;
  const dy = docking ? dock.y - DOCK.height / 2 - startRect.top
    : settled ? MARGIN - startRect.top : 0;

  return createPortal(
    <div
      className="vendo-root fl-morph-layer"
      data-vendo-motion={reduced ? "reduced" : theme.motion}
      style={{ ...themeCssVariables(theme) } as React.CSSProperties}
    >
      <div
        className="fl-morph-card"
        style={{
          position: "absolute",
          top: startRect.top,
          left: startRect.left,
          width: docking ? DOCK.width : settled ? PILL.width : startRect.width,
          height: docking ? DOCK.height : settled ? PILL.height : Math.min(startRect.height, 96),
          transform: `translate(${dx}px, ${dy}px)${docking ? " scale(.5)" : ""}`,
          opacity: leaving || docking ? 0 : 1,
          transition: reduced
            ? "opacity .3s"
            : docking
              ? `transform ${DOCK_MS}ms ${sink}, width ${DOCK_MS}ms ${sink}, height ${DOCK_MS}ms ${sink}, opacity .45s ease .1s`
              : `transform .64s ${spring}, width .64s ${spring}, height .64s ${spring}, opacity .4s ease`,
        }}
      >
        <span className="fl-morph-live" aria-hidden="true" />
        <div className="fl-morph-copy">
          <div className="fl-morph-title">{title}</div>
          {sub ? <div className="fl-morph-sub">{sub}</div> : null}
        </div>
        {logoUrl ? (
          <span className="fl-morph-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl} alt="" width={18} height={18} />
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
