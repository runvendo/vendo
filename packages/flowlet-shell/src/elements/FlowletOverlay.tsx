import { useEffect, useState } from "react";
import { FlowletThread, type FlowletThreadProps } from "../FlowletThread";
import { OverlayPanel } from "../components/OverlayPanel";

export interface FlowletOverlayProps extends FlowletThreadProps {
  launcherLabel?: string;
  /** Open with this keyboard shortcut key (with meta/ctrl). Default "k". */
  shortcutKey?: string;
  /** Controlled open state. When provided, the parent owns open/close. */
  open?: boolean;
  /** Controlled open change handler. Pair with `open`. */
  onOpenChange?: (open: boolean) => void;
}

export function FlowletOverlay({
  launcherLabel = "Ask",
  shortcutKey = "k",
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

  // Invisible until summoned (Cmd/Ctrl+K) — no persistent launcher.
  return (
    <OverlayPanel open={open} onClose={() => setOpen(false)} ariaLabel={launcherLabel}>
      <FlowletThread {...thread} />
    </OverlayPanel>
  );
}
