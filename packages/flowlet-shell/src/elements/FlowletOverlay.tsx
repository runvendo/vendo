import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FlowletThread, type FlowletThreadProps } from "../FlowletThread";
import { useFocusTrap } from "../use-focus-trap";

export interface FlowletOverlayProps extends FlowletThreadProps {
  launcherLabel?: string;
  /** Open with this keyboard shortcut key (with meta/ctrl). Default "k". */
  shortcutKey?: string;
  /** Hide the launcher button — the overlay is opened purely via the shortcut. */
  hideLauncher?: boolean;
  /** Controlled open state. When provided, the parent owns open/close. */
  open?: boolean;
  /** Controlled open change handler. Pair with `open`. */
  onOpenChange?: (open: boolean) => void;
}

export function FlowletOverlay({
  launcherLabel = "Ask",
  shortcutKey = "k",
  hideLauncher = false,
  open: openProp,
  onOpenChange,
  ...thread
}: FlowletOverlayProps) {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const setOpen = (next: boolean) => {
    if (!controlled) setOpenState(next);
    onOpenChange?.(next);
  };
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === shortcutKey) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutKey, open, controlled]);

  useFocusTrap(open, panelRef);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") setOpen(false);
  };

  if (!open) {
    if (hideLauncher || controlled) return null;
    return (
      <button type="button" className="fl-launcher" onClick={() => setOpen(true)}>{launcherLabel}</button>
    );
  }

  return (
    <>
      <div className="fl-overlay-scrim" onClick={() => setOpen(false)} />
      <div
        className="fl-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label={launcherLabel}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <FlowletThread {...thread} />
      </div>
    </>
  );
}
