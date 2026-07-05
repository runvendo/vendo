import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VendoThread, type VendoThreadProps } from "../VendoThread";
import { OverlayPanel } from "../components/OverlayPanel";
import { useShell } from "../context";

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
  const { scope } = useShell();
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

  // A VendoRemix affordance click scopes the shared overlay and summons it.
  const activeScope = useSyncExternalStore(scope.subscribe, scope.current, () => null);
  useEffect(() => {
    if (activeScope && !open) setOpen(true);
    // Opening is the only reaction; closing is handled below so the scope
    // clears exactly once, on actual close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope]);

  // EVERY close path clears the scope — including Cmd/Ctrl+K toggles and a
  // controlling parent flipping `open` — or the next plain send would still
  // carry the old anchor's snapshot (Codex review, 2026-07-04). Transition-
  // detected so a scope set moments before the overlay opens is not wiped.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) scope.clear();
    wasOpen.current = open;
  }, [open, scope]);

  const close = () => {
    setOpen(false);
    scope.clear();
  };

  // Invisible until summoned (Cmd/Ctrl+K or a scoped affordance click).
  return (
    <OverlayPanel open={open} onClose={close} ariaLabel={launcherLabel}>
      {activeScope && (
        <div className="fl-scope-bar" data-testid="scope-bar">
          <span className="fl-scope-label">✦ {activeScope.label ?? activeScope.anchorId}</span>
          <button
            type="button"
            className="fl-scope-clear"
            aria-label="Clear scope"
            onClick={() => scope.clear()}
          >
            ✕
          </button>
        </div>
      )}
      <VendoThread {...thread} />
    </OverlayPanel>
  );
}
