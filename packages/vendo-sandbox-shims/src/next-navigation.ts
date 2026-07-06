/**
 * Minimal `next/navigation` shim. `useRouter().push/replace` (and `redirect`)
 * route the host app via vendo.navigate. `redirect`/`notFound` throw to unwind
 * the render (Next semantics, caught by the sandbox error boundary). The read
 * hooks (usePathname/useSearchParams/useParams) resolve the host's real route
 * from the read-only `window.__vendoRouteData` channel, falling back to empty
 * values when absent; the router history methods stay safe no-ops so they never
 * crash a render or event handler.
 */
import { navigate } from "./dispatch.js";

/** Read-only route channel the host injects (`window.__vendoRouteData`, set by
 *  the stage runtime parallel to `__vendoAnchorData`). `search` is a raw query
 *  string like "?q=1"; `params` is Next's dynamic-route params object. */
interface RouteDataWindow {
  __vendoRouteData?: { pathname?: string; search?: string; params?: Record<string, string | string[]> };
}

/** Never crashes when the channel is absent (SSR / no host): returns {}. */
function routeData(): NonNullable<RouteDataWindow["__vendoRouteData"]> {
  return (globalThis as unknown as RouteDataWindow).__vendoRouteData ?? {};
}

export function useRouter() {
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href),
    // No history channel exists between the sandbox and the host router, so
    // back/forward can't do anything real. They are safe no-ops rather than
    // throwing, because these are wired to onClick handlers and an exception
    // there would crash the component instead of just being inert.
    back: () => {
      /* no-op: no host history bridge */
    },
    forward: () => {
      /* no-op: no host history bridge */
    },
    refresh: () => {
      /* no-op: the host owns refresh */
    },
    prefetch: () => {
      /* no-op */
    },
  };
}

/** The host's real pathname from the route channel (fallback "" with no host). */
export function usePathname(): string {
  return routeData().pathname ?? "";
}

/** The host's real query string, parsed from the route channel (fallback empty). */
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(routeData().search ?? "");
}

/** The host's real dynamic-route params from the route channel. Returns an empty
 *  object when the channel is absent rather than crash a component reading
 *  `params.id`. */
export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return (routeData().params ?? {}) as T;
}

/** Recognizable codes so a host/error-boundary can tell these apart from real
 *  errors (mirrors Next's NEXT_REDIRECT / NEXT_NOT_FOUND digests). */
export const REDIRECT_ERROR_CODE = "VENDO_REDIRECT";
export const NOT_FOUND_ERROR_CODE = "VENDO_NOT_FOUND";

/** `redirect(url)` in Next THROWS to unwind rendering so the protected content
 *  below it never renders. We must do the same: kick off the navigation, then
 *  throw. A no-op-return would let the guarded component render its protected
 *  branch before/if navigation resolves. In the sandbox this throw hits the
 *  error boundary — exactly the "stop rendering protected content" behavior. */
export function redirect(url: string): never {
  // Fire-and-forget (we throw immediately and cannot await); catch so a blocked
  // navigation doesn't become an unhandled rejection.
  void navigate(url).catch(() => {});
  throw Object.assign(new Error(`[vendo] redirect(${url})`), { code: REDIRECT_ERROR_CODE });
}

/** `notFound()` in Next THROWS NEXT_NOT_FOUND to stop rendering and show the
 *  not-found segment. Throw likewise so the invalid content below never renders;
 *  in the sandbox the error boundary catches it. */
export function notFound(): never {
  throw Object.assign(new Error("[vendo] notFound()"), { code: NOT_FOUND_ERROR_CODE });
}

/** No layout-segment routing in the sandbox — mirror Next's "no segment" values. */
export function useSelectedLayoutSegment(): string | null {
  return null;
}

export function useSelectedLayoutSegments(): string[] {
  return [];
}
