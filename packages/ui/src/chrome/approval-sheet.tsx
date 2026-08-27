import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { themeCssVariables } from "../theme.js";
import { ensureChromeStyles, useChromeTheme } from "./chrome-root.js";

/**
 * Below the mobile breakpoint the newest pending approval
 * presents as a bottom sheet instead of an in-list card: grabber, scrim,
 * safe-area + keyboard-inset padding, slide-up entrance (fade under reduced
 * motion).
 *
 * A consent must be decided explicitly: the scrim does NOT dismiss and Esc
 * (inside the sheet) is a no-op — the only exits are the card's own
 * Approve/Deny (the caller unmounts the sheet when the approval resolves).
 * NON-modal on purpose (voice-approval-overlap regression): only the sheet
 * itself takes pointer events, so at short viewports the surfaces it slides
 * over — the voice stage's controls — stay usable while the consent waits.
 *
 * Portals to <body> with its own theme boundary (the MorphToast pattern) so
 * no host stacking context can trap it. The child is the regular
 * <ApprovalCard> — it keeps every behavior (remember, error, busy) and, spec
 * §16 law 1, the sheet only SIZES it: this ancestor used to strip the card's
 * padding, border and background, which is why the same consent looked like a
 * different product on a phone. The approve morph keeps working because the
 * DOM still carries `.fl-approval` for the start-rect lookup.
 */
export function ApprovalSheet({ children, label }: {
  children: ReactNode;
  /** Accessible name for the dialog, e.g. `Approval for ${title}`. */
  label: string;
}) {
  // The spawning surface's resolved theme, not the provider's: the sheet is the
  // mobile presentation of a consent raised inside a thread, and it portals to
  // <body>, so context is the only way that surface's own `theme` reaches it.
  // Outside any boundary this is the provider's theme, unchanged.
  const theme = useChromeTheme();
  const takeover = useMobileTakeover();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(ensureChromeStyles, []);

  // Focus lands on the sheet on mount so the consent is the immediate
  // keyboard context. The sheet is NON-modal (voice-approval-overlap
  // regression): pointer and Tab traffic to the surfaces behind it stays
  // live — at short viewports the voice stage's controls must remain usable
  // while a consent is pending — so there is no focus trap. Esc is swallowed
  // only INSIDE the sheet (deciding is the only way out of the consent; the
  // rest of the page keeps its own Esc semantics).
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    sheet.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!(event.target instanceof Node) || !sheet.contains(event.target)) return;
      event.stopPropagation();
      event.preventDefault();
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
      data-vendo-ignore=""
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      style={{ ...themeCssVariables(theme), ...takeover.style } as CSSProperties}
    >
      {/* Deliberately inert: a consent is decided, never dismissed-by-tap —
          and hit-transparent, so the surfaces it dims stay usable. */}
      <div className="fl-approval-sheet-scrim" aria-hidden="true" />
      <div
        ref={sheetRef}
        className="fl-approval-sheet"
        role="dialog"
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
