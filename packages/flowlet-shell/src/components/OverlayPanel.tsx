import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { themeToStyle } from "../theme";
import { useShell } from "../context";
import { useFocusTrap } from "../use-focus-trap";

export interface OverlayPanelProps {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  children: ReactNode;
}

/**
 * The shared centered modal used by the Cmd/Ctrl+K overlay AND the dashboard slot
 * — one implementation so they look and behave identically.
 *
 * It PORTALS to document.body so the fixed scrim/panel are positioned relative to
 * the viewport (centered on screen, full-bleed blur). Rendering inline would let
 * a transformed/filtered ancestor (e.g. the slot's themed card) become the
 * containing block, centering the modal on the card instead of the screen. The
 * portal re-applies the host theme via a `flowlet-root` wrapper so CSS vars hold.
 */
export function OverlayPanel({ open, onClose, ariaLabel, children }: OverlayPanelProps) {
  const { theme, cssVars } = useShell();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useFocusTrap(open, panelRef);

  if (!open || !mounted) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose();
  };

  return createPortal(
    <div className="flowlet-root fl-overlay-portal" style={{ ...themeToStyle(theme), ...cssVars }}>
      <div className="fl-overlay-scrim" onClick={onClose} />
      <div
        className="fl-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
