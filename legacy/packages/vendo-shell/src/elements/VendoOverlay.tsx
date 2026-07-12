import { useEffect, useState } from "react";
import { VendoThread, type VendoThreadProps } from "../VendoThread";
import { OverlayPanel } from "../components/OverlayPanel";

export interface VendoOverlayProps extends VendoThreadProps {
  launcherLabel?: string;
  /** Open with this keyboard shortcut key (with meta/ctrl). Default "k". */
  shortcutKey?: string;
  /** Controlled open state. When provided, the parent owns open/close. */
  open?: boolean;
  /** Controlled open change handler. Pair with `open`. */
  onOpenChange?: (open: boolean) => void;
}

export function VendoOverlay({
  launcherLabel = "Ask",
  shortcutKey = "k",
  open: openProp,
  onOpenChange,
  ...thread
}: VendoOverlayProps) {
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

  // Toast click-throughs (and other surfaces) summon the overlay by event.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("vendo:open-overlay", onOpen);
    return () => window.removeEventListener("vendo:open-overlay", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled]);

  const close = () => {
    setOpen(false);
  };

  // Invisible until summoned (Cmd/Ctrl+K or a scoped affordance click).
  return (
    <OverlayPanel open={open} onClose={close} ariaLabel={launcherLabel}>
      <VendoThread {...thread} />
    </OverlayPanel>
  );
}
