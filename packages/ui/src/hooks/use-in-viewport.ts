/**
 * "Has this node been on screen yet?" — the gate a list of LIVE app tiles needs
 * (post-check H16).
 *
 * Each tile is a real mounted app (a boot, an open, sometimes an iframe), so a
 * grid of thirty apps booted thirty machines, most of them below the fold. This
 * pairs with `useApp(appId, { enabled })`: a tile pays for itself when the
 * reader scrolls to it.
 *
 * Sticky on purpose — once an app is live, scrolling past it must not tear it
 * down and boot it again. Internal to the package (chrome imports it directly);
 * hosts get the same effect through `useApp`'s `enabled`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How far ahead of the viewport a tile starts booting, so it is ready by the
 *  time it is actually looked at. */
const AHEAD = "200px";

export function useInViewport<T extends Element>(rootMargin = AHEAD): {
  ref: (node: T | null) => void;
  seen: boolean;
} {
  const [seen, setSeen] = useState(false);
  const observerRef = useRef<IntersectionObserver | undefined>(undefined);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = undefined;
    if (node === null || seen) return;
    // No IntersectionObserver (SSR hydration edge, jsdom, older engines): treat
    // the node as on screen. A missing browser API must never hide a surface.
    if (typeof IntersectionObserver !== "function") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setSeen(true);
    }, { rootMargin });
    observer.observe(node);
    observerRef.current = observer;
  }, [rootMargin, seen]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, seen };
}
