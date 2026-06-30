import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FlowletThread, type FlowletThreadProps } from "../FlowletThread";

export interface FlowletOverlayProps extends FlowletThreadProps {
  launcherLabel?: string;
  /** Open with this keyboard shortcut key (with meta/ctrl). Default "k". */
  shortcutKey?: string;
}

export function FlowletOverlay({ launcherLabel = "Ask", shortcutKey = "k", ...thread }: FlowletOverlayProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === shortcutKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutKey]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") setOpen(false);
  };

  if (!open) {
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
