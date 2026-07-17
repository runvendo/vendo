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
 */
export interface MorphToastProps {
  startRect: { top: number; left: number; width: number; height: number };
  title: string;
  sub?: string;
  logoUrl?: string;
  theme: VendoTheme;
  holdMs?: number;
  onDone(): void;
}

const PILL = { width: 356, height: 62 };
const MARGIN = 18;

export function MorphToast({ startRect, title, sub, logoUrl, theme, holdMs = 3200, onDone }: MorphToastProps) {
  const [settled, setSettled] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    const hold = setTimeout(() => setLeaving(true), (reduced ? 0 : 640) + holdMs);
    const end = setTimeout(() => doneRef.current(), (reduced ? 0 : 640) + holdMs + 460);
    return () => { cancelAnimationFrame(raf); clearTimeout(hold); clearTimeout(end); };
  }, [holdMs, reduced]);

  if (typeof window === "undefined" || typeof document === "undefined") return null;

  const targetLeft = window.innerWidth - PILL.width - MARGIN;
  const dx = settled ? targetLeft - startRect.left : 0;
  const dy = settled ? MARGIN - startRect.top : 0;
  const spring = "cubic-bezier(.34,1.28,.42,1)";

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
          width: settled ? PILL.width : startRect.width,
          height: settled ? PILL.height : Math.min(startRect.height, 96),
          transform: `translate(${dx}px, ${dy}px)`,
          opacity: leaving ? 0 : 1,
          transition: reduced
            ? "opacity .3s"
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
