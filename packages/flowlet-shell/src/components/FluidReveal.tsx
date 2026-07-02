import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { loadFluidMotion, loadedFluidMotion } from "./fluid-motion";

export interface FluidRevealProps {
  /** Which face of the render slot is live. */
  phase: "skeleton" | "view";
  children: ReactNode;
}

// fluidkit's flow easing (FlowStagger's settle curve).
const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/**
 * One render slot: the persistent wrapper that a skeleton and the view that
 * replaces it share, so the swap can be a fluid morph instead of a remount.
 * fluidkit's principle applies — the surface (card height) springs, the faces
 * only cross-fade/translate/un-blur; sandboxed view content is never scaled.
 *
 * The reveal plays only on an OBSERVED skeleton→view flip: restored threads
 * mount straight into view phase and stay static. Enhancement layer: if the
 * motion toolkit isn't loaded (or reduced motion is on), the swap is instant —
 * exactly the pre-fluidkit behavior.
 */
export function FluidReveal({ phase, children }: FluidRevealProps) {
  const container = useRef<HTMLDivElement>(null);
  const entering = useRef<HTMLDivElement>(null);
  const exitingEl = useRef<HTMLDivElement>(null);
  const prevPhase = useRef(phase);
  const lastSkeleton = useRef<ReactNode>(null);
  const skeletonHeight = useRef(0);
  const [exiting, setExiting] = useState<ReactNode>(null);
  const [animating, setAnimating] = useState(false);

  // While the skeleton is up: preload the toolkit (the view usually lands
  // seconds later — the first reveal must not miss), remember the skeleton
  // face for the cross-fade, and track its height for the surface spring.
  useEffect(() => {
    if (phase !== "skeleton") return;
    void loadFluidMotion();
    lastSkeleton.current = children;
  });
  useLayoutEffect(() => {
    if (phase === "skeleton" && container.current) {
      skeletonHeight.current = container.current.offsetHeight;
    }
  });

  // Flip detection. Runs before paint; the setState below re-renders
  // synchronously, so the exiting overlay and the hidden entering face are
  // both in place before the swap ever hits the screen.
  useLayoutEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = phase;
    if (was !== "skeleton" || phase !== "view") return;
    const toolkit = loadedFluidMotion();
    if (!toolkit || toolkit.prefersReducedMotion() === true) return;
    setExiting(lastSkeleton.current);
    setAnimating(true);
  }, [phase]);

  // The morph itself, once the overlay render is committed.
  useLayoutEffect(() => {
    if (!animating) return;
    const toolkit = loadedFluidMotion();
    const host = container.current;
    const enter = entering.current;
    const finish = () => {
      setExiting(null);
      setAnimating(false);
    };
    if (!toolkit || !host || !enter) {
      finish();
      return;
    }
    const oldHeight = skeletonHeight.current;
    const newHeight = host.offsetHeight;
    host.style.overflow = "hidden";
    enter.style.opacity = "0";
    const animations = [
      toolkit.animate(
        host,
        { height: [`${oldHeight}px`, `${newHeight}px`] },
        { type: "spring", stiffness: 220, damping: 28 },
      ),
      toolkit.animate(
        enter,
        { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"], filter: ["blur(8px)", "blur(0px)"] },
        { duration: 0.45, ease: EASE },
      ),
    ];
    if (exitingEl.current) {
      animations.push(
        toolkit.animate(
          exitingEl.current,
          { opacity: [1, 0], filter: ["blur(0px)", "blur(4px)"] },
          { duration: 0.25, ease: "easeOut" },
        ),
      );
    }
    let cancelled = false;
    void Promise.all(animations.map((a) => Promise.resolve(a).catch(() => undefined))).then(() => {
      if (cancelled) return;
      host.style.overflow = "";
      host.style.height = "";
      enter.style.opacity = "";
      enter.style.transform = "";
      enter.style.filter = "";
      finish();
    });
    return () => {
      cancelled = true;
      for (const a of animations) (a as { stop?: () => void }).stop?.();
    };
  }, [animating]);

  return (
    <div ref={container} className="fl-reveal" data-phase={phase}>
      {phase === "view" ? (
        <div ref={entering} className="fl-reveal-enter">
          {children}
        </div>
      ) : (
        children
      )}
      {exiting != null && (
        <div ref={exitingEl} className="fl-reveal-exit" aria-hidden="true">
          {exiting}
        </div>
      )}
    </div>
  );
}
