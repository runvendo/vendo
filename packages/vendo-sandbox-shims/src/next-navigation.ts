/**
 * Minimal `next/navigation` shim. `useRouter().push/replace` route the host
 * app via vendo.navigate; the rest throw descriptive contained errors rather
 * than silently misbehaving.
 */
import { navigate } from "./dispatch.js";

export function useRouter() {
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href),
    back: () => {
      throw new Error("[vendo] router.back() is not available in a remixed component");
    },
    forward: () => {
      throw new Error("[vendo] router.forward() is not available in a remixed component");
    },
    refresh: () => {
      /* no-op: the host owns refresh */
    },
    prefetch: () => {
      /* no-op */
    },
  };
}

export function usePathname(): string {
  return "";
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}

/** No route channel exists in the sandbox yet, so there are no dynamic route
 *  params to surface — return an empty object rather than crash a component
 *  that reads `params.id`. */
export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return {} as T;
}

/** `redirect(url)` in Next throws to unwind rendering; that is impossible here,
 *  so route through the same navigate bridge `useRouter().push` uses and return.
 *  A blocked redirect surfaces via the bridge (see dispatch), not an exception
 *  thrown into React render. */
export function redirect(url: string): void {
  navigate(url);
}

/** `notFound()` in Next throws NEXT_NOT_FOUND to render the not-found segment.
 *  The sandbox has no not-found boundary, and throwing would crash the render,
 *  so treat it as a safe no-op — the component keeps rendering. */
export function notFound(): void {
  /* no-op: no not-found boundary in the sandbox */
}

/** No layout-segment routing in the sandbox — mirror Next's "no segment" values. */
export function useSelectedLayoutSegment(): string | null {
  return null;
}

export function useSelectedLayoutSegments(): string[] {
  return [];
}
