import { useSyncExternalStore } from "react";

/** Below this viewport width every open Vendo surface presents full-screen
 *  (the Intercom pattern) — host layout below the breakpoint is covered, not
 *  negotiated with. One breakpoint, no per-host configuration in v1. */
export const MOBILE_TAKEOVER_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia === "undefined") return () => {};
  const mql = matchMedia(MOBILE_TAKEOVER_QUERY);
  // Modern MediaQueryList is an EventTarget; older Safari only has addListener.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

function getSnapshot(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia(MOBILE_TAKEOVER_QUERY).matches;
}

/**
 * True when the viewport is below the mobile-takeover breakpoint. Surface
 * containers (the overlay panel, the page element — the slot's design overlay
 * rides the shared OverlayPanel) add the `fl-takeover` class on it; styles.css
 * carries the actual full-screen presentation, so this stays CSS-first with
 * matchMedia only picking which face is live. SSR renders desktop.
 */
export function useMobileTakeover(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
