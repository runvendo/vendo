import { useCallback, useMemo, useState } from "react";

export interface VendoOverlayController {
  /** Whether the overlay is currently open. */
  isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Discard the overlay's current conversation and start a fresh thread
   *  (ENG-221) — the headless twin of the panel's new-conversation button. */
  newConversation(): void;
  /** Spread onto `<VendoOverlay />` to hand it this controller's state. */
  overlayProps: { open: boolean; onOpenChange(open: boolean): void; conversationKey: number };
}

/**
 * Programmatic open/close for `<VendoOverlay />` (ENG-220): a tiny controlled-
 * state helper so hosts can wire their own triggers (keyboard shortcuts, nav
 * buttons) without DOM-poking the launcher.
 *
 * ```tsx
 * const overlay = useVendoOverlay();
 * // overlay.toggle() from your own ⌘K handler…
 * return <VendoOverlay {...overlay.overlayProps} />;
 * ```
 */
export function useVendoOverlay(options: { defaultOpen?: boolean } = {}): VendoOverlayController {
  const [isOpen, setOpen] = useState(options.defaultOpen ?? false);
  const [conversationKey, setConversationKey] = useState(0);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen(value => !value), []);
  const newConversation = useCallback(() => setConversationKey(value => value + 1), []);
  const overlayProps = useMemo(
    () => ({ open: isOpen, onOpenChange: setOpen, conversationKey }),
    [isOpen, conversationKey],
  );
  return useMemo(
    () => ({ isOpen, open, close, toggle, newConversation, overlayProps }),
    [isOpen, open, close, toggle, newConversation, overlayProps],
  );
}
