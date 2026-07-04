import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { animate } from "motion";
import { LiquidCard, resolvePrefersReducedMotion } from "fluidkit";
import { themeToStyle } from "../theme";
import { useShell } from "../context";
import { useFocusTrap } from "../use-focus-trap";

export interface OverlayPanelProps {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  children: ReactNode;
}

/** fluidkit's static-safe semantics: unknown (SSR) → treated as reduced. */
function prefersReducedMotion(): boolean {
  const raw =
    typeof matchMedia !== "undefined" ? matchMedia("(prefers-reduced-motion: reduce)").matches : null;
  return resolvePrefersReducedMotion(raw);
}

/**
 * The shared centered modal used by the Cmd/Ctrl+K overlay AND the dashboard slot
 * — one implementation so they look and behave identically.
 *
 * It PORTALS to document.body so the fixed scrim/panel are positioned relative to
 * the viewport (centered on screen, full-bleed blur). Rendering inline would let
 * a transformed/filtered ancestor (e.g. the slot's themed card) become the
 * containing block, centering the modal on the card instead of the screen. The
 * portal re-applies the host theme via a `flowlet-root` wrapper so CSS vars hold
 * (fluidkit's theme context crosses the portal on its own).
 *
 * The shell owns the dialog lifecycle — portal, scrim, focus trap, Escape,
 * close-button placement; fluidkit's LiquidCard is only the visual surface
 * (brand-tinted glass, rim light) behind the content.
 */
export function OverlayPanel({ open, onClose, ariaLabel, children }: OverlayPanelProps) {
  const { theme, cssVars } = useShell();
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  // Trails `open` by a short exit fade on close (instant under reduced motion).
  const [visible, setVisible] = useState(open);
  useEffect(() => setMounted(true), []);
  useFocusTrap(open, panelRef);

  useEffect(() => {
    if (open) {
      setVisible(true);
      return;
    }
    const el = rootRef.current;
    if (prefersReducedMotion() || !el) {
      setVisible(false);
      return;
    }
    // Opacity-only: the panel's centering lives in its transform, so the exit
    // must not touch transforms.
    const control = animate(el, { opacity: [1, 0] }, { duration: 0.15, ease: "easeIn" });
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

  if (!visible || !mounted) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose();
  };

  return createPortal(
    <div ref={rootRef} className="flowlet-root fl-overlay-portal" style={{ ...themeToStyle(theme), ...cssVars }}>
      <div className="fl-overlay-scrim" onClick={onClose} />
      <div
        className="fl-overlay-panel fl-overlay-panel--liquid"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <LiquidCard className="fl-overlay-card" padding={0}>
          {children}
        </LiquidCard>
        {/* AFTER the content in DOM order (absolute-positioned, so visually
            top-right regardless): the focus trap sends initial focus to the
            first focusable descendant, and that must stay the content — with
            the X first, opening the overlay focused Close and Enter dismissed
            the dialog the user just opened. */}
        <button type="button" className="fl-overlay-close" aria-label="Close" onClick={onClose}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
