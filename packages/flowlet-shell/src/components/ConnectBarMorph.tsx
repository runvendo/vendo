import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { loadFluidMotion, loadedFluidMotion } from "./fluid-motion";

export interface ConnectBarMorphProps {
  /** false = the composer bar face; true = the integrations panel face. */
  open: boolean;
  onClose: () => void;
  bar: ReactNode;
  panel: ReactNode;
}

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/**
 * Treatment C: the chat bar IS the surface. Toggling morphs the container
 * between its two content-sized faces — height springs, faces cross-fade with
 * a light blur, nothing scales (fluidkit's surface/content split, done with
 * the same loader as FluidReveal). Toolkit missing / reduced motion: the
 * faces just swap.
 */
export function ConnectBarMorph({ open, onClose, bar, panel }: ConnectBarMorphProps) {
  const container = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);
  const fromHeight = useRef(0);
  const prevOpen = useRef(open);
  const [animating, setAnimating] = useState(false);

  // Flip detection runs FIRST (declaration order): at this point lastHeight
  // still holds the previous commit's face box — stash it before the tracker
  // effect below overwrites it with the new face's height.
  useLayoutEffect(() => {
    const was = prevOpen.current;
    prevOpen.current = open;
    if (was === open) return;
    const toolkit = loadedFluidMotion();
    if (!toolkit || toolkit.prefersReducedMotion()) return;
    fromHeight.current = lastHeight.current;
    setAnimating(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!animating) return;
    const toolkit = loadedFluidMotion();
    const el = container.current;
    const fc = face.current;
    if (!toolkit || !el || !fc) {
      setAnimating(false);
      return;
    }
    const oldHeight = fromHeight.current;
    const newHeight = el.offsetHeight;
    el.style.overflow = "hidden";
    const controls = [
      toolkit.animate(
        el,
        { height: [`${oldHeight}px`, `${newHeight}px`] },
        { type: "spring", stiffness: 300, damping: 30 },
      ),
      toolkit.animate(
        fc,
        { opacity: [0, 1], filter: ["blur(6px)", "blur(0px)"] },
        { duration: 0.3, ease: EASE },
      ),
    ];
    let cancelled = false;
    void Promise.all(controls.map((c) => Promise.resolve(c).catch(() => undefined))).then(() => {
      if (cancelled) return;
      el.style.overflow = "";
      el.style.height = "";
      fc.style.opacity = "";
      fc.style.filter = "";
      setAnimating(false);
    });
    return () => {
      cancelled = true;
      for (const c of controls) (c as { stop?: () => void }).stop?.();
    };
  }, [animating]);

  useLayoutEffect(() => {
    if (container.current) lastHeight.current = container.current.offsetHeight;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) onClose();
  };

  return (
    <div ref={container} className="fl-barmorph" data-open={open} onKeyDown={onKeyDown}>
      <div ref={face} className="fl-barmorph-face" key={open ? "panel" : "bar"}>
        {open ? panel : bar}
      </div>
    </div>
  );
}
