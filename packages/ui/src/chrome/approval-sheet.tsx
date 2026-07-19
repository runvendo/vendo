import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoTheme } from "../context.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { themeCssVariables } from "../theme.js";
import { ensureChromeStyles } from "./chrome-root.js";

/**
 * Lane pick 1-H — below the mobile breakpoint the newest pending approval
 * presents as a bottom sheet instead of an in-list card: grabber, scrim,
 * safe-area + keyboard-inset padding, slide-up entrance (fade under reduced
 * motion).
 *
 * A consent must be decided explicitly: the scrim does NOT dismiss and Esc is
 * a no-op — the only exits are the card's own Approve/Deny (the caller
 * unmounts the sheet when the approval resolves).
 *
 * Portals to <body> with its own theme boundary (the MorphToast pattern) so
 * no host stacking context can trap it. The child is the regular
 * <ApprovalCard> — it keeps every behavior (remember, error, busy) and the
 * sheet CSS sheds the card's own chrome; the approve morph keeps working
 * because the DOM still carries `.fl-approval` for the start-rect lookup.
 */
export function ApprovalSheet({ children, label }: {
  children: ReactNode;
  /** Accessible name for the dialog, e.g. `Approval for ${title}`. */
  label: string;
}) {
  const theme = useVendoTheme();
  const takeover = useMobileTakeover();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(ensureChromeStyles, []);

  // Focus lands on the sheet on mount; a minimal trap keeps Tab inside (the
  // sheet is the only interactive surface while the consent is pending on
  // mobile). Esc is swallowed: deciding is the only way out.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    sheet.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = sheet.querySelectorAll<HTMLElement>(
        'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="vendo-root fl-approval-sheet-layer"
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      style={{ ...themeCssVariables(theme), ...takeover.style } as CSSProperties}
    >
      {/* Deliberately inert: a consent is decided, never dismissed-by-tap. */}
      <div className="fl-approval-sheet-scrim" aria-hidden="true" />
      <div
        ref={sheetRef}
        className="fl-approval-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <div className="fl-approval-sheet-grabber" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
