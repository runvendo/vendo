import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";

/** The takeover breakpoint from the designed CSS: full-bleed below 768px
 *  (chrome-css.ts, "full-screen mobile takeover"). */
const MOBILE_TAKEOVER_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOBILE_TAKEOVER_QUERY);
  // Safari < 14 ships MediaQueryList without addEventListener.
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_TAKEOVER_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false; // SSR renders desktop chrome; the client stamps on hydration.
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
