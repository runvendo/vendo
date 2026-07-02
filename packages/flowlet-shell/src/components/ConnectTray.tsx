import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { loadFluidMotion, loadedFluidMotion } from "./fluid-motion";

export interface ConnectTrayProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/**
 * The liquid tray: anchors above the composer and morphs out of the bar's top
 * edge (height spring + un-blur + rise). Enhancement layer per ENG-205 —
 * toolkit missing or reduced motion means it simply appears, like any popover.
 * Mounted only while open, so surfaces without it pay nothing.
 */
export function ConnectTray({ open, onClose, children }: ConnectTrayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  // The tray stays mounted through a short exit animation on close; `visible`
  // trails `open` by that much. No toolkit / reduced motion: trails by nothing.
  const [visible, setVisible] = useState(open);

  // Preload alongside first render so the first open can animate.
  useEffect(() => {
    void loadFluidMotion();
  }, []);

  useEffect(() => {
    if (open) {
      setVisible(true);
      return;
    }
    const toolkit = loadedFluidMotion();
    const el = ref.current;
    if (!toolkit || toolkit.prefersReducedMotion() || !el) {
      setVisible(false);
      return;
    }
    const control = toolkit.animate(
      el,
      { opacity: [1, 0], transform: ["translateY(0px)", "translateY(10px)"], filter: ["blur(0px)", "blur(5px)"] },
      { duration: 0.16, ease: "easeIn" },
    );
    let cancelled = false;
    void Promise.resolve(control)
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setVisible(false);
      });
    return () => {
      cancelled = true;
      (control as { stop?: () => void }).stop?.();
    };
  }, [open]);

  // Entrance runs on the commit where the tray appears; layout effect =
  // initial styles land before paint (no flash at full opacity).
  useLayoutEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    const toolkit = loadedFluidMotion();
    const el = ref.current;
    if (!toolkit || toolkit.prefersReducedMotion() || !el) return;
    const height = el.offsetHeight;
    const controls = [
      toolkit.animate(
        el,
        { height: [`${Math.round(height * 0.4)}px`, `${height}px`] },
        { type: "spring", stiffness: 320, damping: 30 },
      ),
      toolkit.animate(
        el,
        { opacity: [0, 1], transform: ["translateY(14px)", "translateY(0px)"], filter: ["blur(7px)", "blur(0px)"] },
        { duration: 0.35, ease: EASE },
      ),
    ];
    void Promise.all(controls.map((c) => Promise.resolve(c).catch(() => undefined))).then(() => {
      el.style.height = "";
      el.style.opacity = "";
      el.style.transform = "";
      el.style.filter = "";
    });
    return () => {
      for (const c of controls) (c as { stop?: () => void }).stop?.();
    };
  }, [open]);

  // Outside pointer-down closes (listener lives only while open).
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      // The dock button toggles; closing here too would reopen on its click.
      if (e.target instanceof Element && e.target.closest(".fl-dock")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onClose]);

  if (!open && !visible) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div ref={ref} className="fl-tray" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
