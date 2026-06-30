import { useEffect } from "react";
import type { RefObject } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard focus inside `containerRef` while `active` is true.
 * On activation: moves focus into the container (first focusable child, or the
 * container itself). On deactivation: restores focus to the element that held
 * it before activation, if that element is still in the DOM.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Capture the currently-focused element so we can restore it on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus to the first focusable descendant, or the container itself.
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    const firstFocusable = focusables[0];
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      container.focus();
    }

    // Tab / Shift+Tab wrapping handler (capture phase so it runs before React).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const els = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (els.length === 0) return;

      const first = els[0];
      const last = els[els.length - 1];
      if (!first || !last) return;

      if (e.shiftKey) {
        // Shift+Tab on first element → jump to last.
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab on last element → jump to first.
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus only if the element is still in the DOM.
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}
