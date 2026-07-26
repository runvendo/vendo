import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";

/** The takeover breakpoint from the designed CSS: full-bleed below 768px
 *  (chrome-css.ts, "full-screen mobile takeover"). */
const MOBILE_TAKEOVER_QUERY = "(max-width: 767px)";

/** The approval bottom sheet needs ROOM: it is bottom-anchored at up to 86vh,
 *  so at short viewport heights it buries everything beneath it — including
 *  the voice stage's controls (the 420x500 voice-approval-overlap
 *  regression). Below this height the consent renders as the in-list card
 *  instead, keeping both surfaces usable. */
const APPROVAL_SHEET_QUERY = "(max-width: 767px) and (min-height: 560px)";

function subscribeTo(mediaQuery: string): (onChange: () => void) => () => void {
  return (onChange) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const query = window.matchMedia(mediaQuery);
    // Safari < 14 ships MediaQueryList without addEventListener.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  };
}

function snapshotOf(mediaQuery: string): () => boolean {
  return () =>
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(mediaQuery).matches;
}

const subscribe = subscribeTo(MOBILE_TAKEOVER_QUERY);
const getSnapshot = snapshotOf(MOBILE_TAKEOVER_QUERY);
const subscribeSheet = subscribeTo(APPROVAL_SHEET_QUERY);
const getSheetSnapshot = snapshotOf(APPROVAL_SHEET_QUERY);

function getServerSnapshot(): boolean {
  return false; // SSR renders desktop chrome; the client stamps on hydration.
}

/** Whether the newest in-thread consent presents as the bottom sheet (1-H):
 *  mobile width AND enough viewport height for the sheet to slide over the
 *  page without burying it. False falls back to the in-list ApprovalCard. */
export function useApprovalSheetPresentation(): boolean {
  return useSyncExternalStore(subscribeSheet, getSheetSnapshot, getServerSnapshot);
}

export interface MobileTakeover {
  /** True below the mobile breakpoint — append `fl-takeover` to the surface. */
  active: boolean;
  /** Pixels of visual viewport the virtual keyboard covers (0 when closed). */
  keyboardInset: number;
  /** Spread onto the takeover surface: carries `--fl-kb-inset` so the
   *  stylesheet can lift the composer above the virtual keyboard. Undefined
   *  when the takeover is inactive, leaving desktop styles untouched. */
  style: CSSProperties | undefined;
}

/**
 * Mobile takeover driver (ENG-228): the chrome surfaces (overlay panel, page,
 * palette) go full-bleed below 768px — the designed `.fl-takeover` mode. The
 * hook tracks the breakpoint via matchMedia and, while active, follows
 * `window.visualViewport` so the on-screen keyboard's height is published as
 * a `--fl-kb-inset` CSS variable on the surface. Environments without
 * matchMedia or visualViewport (SSR, jsdom, old WebViews) degrade to the
 * desktop presentation.
 */
export function useMobileTakeover(): MobileTakeover {
  const active = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    if (!active) {
      setKeyboardInset(0);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      // innerHeight is the layout viewport; the visual viewport shrinks (and
      // may pan, hence offsetTop) when the keyboard opens. The difference is
      // how far the composer must lift. Never negative (pinch-zoom shrinks
      // the visual viewport too, but the keyboard math can round below zero).
      setKeyboardInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [active]);

  return {
    active,
    keyboardInset,
    style: active ? ({ "--fl-kb-inset": `${keyboardInset}px` } as CSSProperties) : undefined,
  };
}
